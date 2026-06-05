// TaskMatrix — Obsidian plugin entry.
//
// Markdown is the API. A task's quadrant is encoded as a `#tm/qN` tag on the
// task line (q1..q4 = Do/Schedule/Delegate/Delete). Status is the checkbox
// character. The plugin owns no off-vault state — every change goes through
// vault.process() and re-derives state from the markdown. This means Claude
// (or any external tool) can manipulate tasks via standard file edits and
// the matrix updates automatically through vault.on('modify').

import { App, ItemView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import {
  STATUS_TO_CHAR,
  STATUS_CYCLE,
  QUADRANTS,
  QUAD_TAG_RE,
  parseTasksFromText,
  rewriteQuadrantInLine,
  rewriteCheckboxInLine,
  mutateArchive,
  mutateTaskText,
  Task,
  TaskStatus,
  Quadrant,
  DetectionMode,
} from './parser';

const DEFAULT_BACKLOG_PATH = 'Task Backlog.md';

interface TaskMatrixSettings {
  detectionMode: DetectionMode;
  backlogPath: string;
}

const DEFAULT_SETTINGS: TaskMatrixSettings = {
  detectionMode: 'tag',
  backlogPath: DEFAULT_BACKLOG_PATH,
};

const VIEW_TYPE = 'task-matrix-view';
const SVG_NS = 'http://www.w3.org/2000/svg';

// Static quadrant metadata for the matrix skeleton.
interface QuadDef {
  id: Quadrant;
  title: string;
  meta: string;
}
const QUAD_DEFS: QuadDef[] = [
  { id: 'q1', title: 'Do', meta: 'Urgent · Important' },
  { id: 'q2', title: 'Schedule', meta: 'Not Urgent · Important' },
  { id: 'q3', title: 'Delegate', meta: 'Urgent · Not Important' },
  { id: 'q4', title: 'Delete', meta: 'Not Urgent · Not Important' },
];

// Build an SVG icon under `parent` from a list of <path d="…"> strings (or a
// single <polyline points="…">). Avoids innerHTML for the static glyphs.
function appendSvg(parent: Element, cls: string, build: (svg: SVGElement) => void): SVGElement {
  const svg = activeDocument.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  if (cls) svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  build(svg);
  parent.appendChild(svg);
  return svg;
}
function svgPath(svg: SVGElement, d: string): void {
  const path = activeDocument.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
}

const ICON_SEARCH = 'M10 4a6 6 0 1 0 3.79 10.66l4.27 4.28 1.42-1.41-4.28-4.27A6 6 0 0 0 10 4zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8z';
const ICON_FILE = 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm0 7V3.5L19.5 9z';

export default class TaskMatrixPlugin extends Plugin {
  tasks: Map<string, Task> = new Map();   // id → task record (includes quadrant)
  views: Set<MatrixView> = new Set();      // active MatrixView instances
  settings: TaskMatrixSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new MatrixView(leaf, this));
    this.addSettingTab(new TaskMatrixSettingTab(this.app, this));

    this.addRibbonIcon('layout-grid', 'Open task matrix', () => this.activateView());

    this.addCommand({
      id: 'open',
      name: 'Open task matrix',
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'add-task-to-backlog',
      name: 'Add task to backlog',
      callback: () => this.openAddTaskModal(),
    });

    this.addCommand({
      id: 'rescan-vault',
      name: 'Rescan vault for task lines',
      callback: async () => {
        await this.scanVault();
        new Notice(`TaskMatrix: ${this.tasks.size} task${this.tasks.size === 1 ? '' : 's'} indexed.`);
      },
    });

    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (file instanceof TFile && file.extension === 'md') void this.refreshFile(file);
    }));
    this.registerEvent(this.app.vault.on('create', (file) => {
      if (file instanceof TFile && file.extension === 'md') void this.refreshFile(file);
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (file instanceof TFile) this.removeFileTasks(file.path);
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFile && file.extension === 'md') {
        this.removeFileTasks(oldPath);
        void this.refreshFile(file);
      }
    }));

    // Defer the initial scan until Obsidian has finished loading the layout.
    // Scanning a large vault during boot would block the UI; onLayoutReady
    // fires after Obsidian's core views are interactive.
    this.app.workspace.onLayoutReady(() => { void this.scanVault(); });
  }

  onunload(): void {
    // Obsidian auto-disposes registered events and views; clear local
    // bookkeeping so any view callback running during teardown sees empty
    // state instead of half-initialized refs. (Reviewer L8.)
    this.views.clear();
    this.tasks.clear();
  }

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  // ─── scan + parse ───────────────────────────────────────────────────────
  async scanVault(): Promise<void> {
    this.tasks.clear();
    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      try {
        const text = await this.app.vault.cachedRead(file);
        this.parseFileText(file.path, text);
      } catch (err) {
        console.warn(`[TaskMatrix] failed to read ${file.path}:`, err);
      }
    }
    this.notify();
  }

  async refreshFile(file: TFile): Promise<void> {
    this.removeFileTasksSilent(file.path);
    try {
      // Use vault.read (not cachedRead) — modify events on some sync backends
      // (iCloud, Dropbox) fire before the cache is updated, so a cachedRead
      // here can return the previous content. (Reviewer M5.)
      const text = await this.app.vault.read(file);
      this.parseFileText(file.path, text);
    } catch (err) {
      console.warn(`[TaskMatrix] failed to refresh ${file.path}:`, err);
    }
    this.notify();
  }

  removeFileTasks(path: string): void {
    this.removeFileTasksSilent(path);
    this.notify();
  }

  removeFileTasksSilent(path: string): void {
    for (const [id, t] of this.tasks) {
      if (t.file === path) this.tasks.delete(id);
    }
  }

  parseFileText(filePath: string, text: string): void {
    for (const task of parseTasksFromText(filePath, text, this.settings.detectionMode)) {
      this.tasks.set(task.id, task);
    }
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<TaskMatrixSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(loaded ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ─── writeback ──────────────────────────────────────────────────────────
  // Status toggle replaces a single character (the checkbox) inside the line.
  // vault.process is atomic — Obsidian serializes writes per file and our
  // mutator runs against the freshest text. We verify the line still has
  // the expected checkbox shape and the previously observed character before
  // writing, so a concurrent edit (user, sync, other plugin) is treated as
  // a conflict and we bail out without clobbering.
  async toggleStatus(taskId: string, newStatus: TaskStatus): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const file = this.app.vault.getAbstractFileByPath(task.file);
    if (!(file instanceof TFile)) return;

    const newChar = STATUS_TO_CHAR[newStatus];
    if (newChar === undefined) return;

    let conflict = false;
    let newRawLine: string | null = null;
    try {
      await this.app.vault.process(file, (text) => {
        const lines = text.split('\n');
        const result = rewriteCheckboxInLine(lines[task.lineNumber], task.rawLine, task.checkChar, newChar);
        if (result.conflict) { conflict = true; return text; }
        lines[task.lineNumber] = result.line as string;
        newRawLine = result.line as string;
        return lines.join('\n');
      });
    } catch (err) {
      new Notice(`TaskMatrix: failed to update task — ${errMessage(err)}`);
      return;
    }

    if (conflict) {
      new Notice('TaskMatrix: file changed underneath — rescanning.');
      await this.refreshFile(file);
      return;
    }

    // Optimistic in-memory update so back-to-back actions chain before the
    // vault.modify event arrives. The modify event will re-parse and confirm.
    task.status = newStatus;
    task.checkChar = newChar;
    if (newRawLine !== null) task.rawLine = newRawLine;
    this.notify();
  }

  // ─── placement ──────────────────────────────────────────────────────────
  // Set the quadrant by rewriting the task's markdown line. Pass null to
  // clear (move to backlog). The line is mutated atomically via vault.process:
  // any existing #tm/qN tag is stripped first, then the new tag (if any) is
  // inserted just before the trailing block ID — keeping `^task-id` last on
  // the line, which is where Obsidian expects it.
  async setQuadrant(taskId: string, quadrant: Quadrant | null): Promise<void> {
    if (quadrant !== null && !QUADRANTS.includes(quadrant)) return;
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (task.quadrant === quadrant) return;
    const file = this.app.vault.getAbstractFileByPath(task.file);
    if (!(file instanceof TFile)) return;

    let conflict = false;
    let newRawLine: string | null = null;
    try {
      await this.app.vault.process(file, (text) => {
        const lines = text.split('\n');
        const result = rewriteQuadrantInLine(lines[task.lineNumber], task.rawLine, quadrant);
        if (result.conflict) { conflict = true; return text; }
        lines[task.lineNumber] = result.line as string;
        newRawLine = result.line as string;
        return lines.join('\n');
      });
    } catch (err) {
      new Notice(`TaskMatrix: failed to update placement — ${errMessage(err)}`);
      return;
    }

    if (conflict) {
      new Notice('TaskMatrix: file changed underneath — rescanning.');
      await this.refreshFile(file);
      return;
    }

    task.quadrant = quadrant;
    task.tags = task.tags.filter((t) => !QUAD_TAG_RE.test(t));
    if (quadrant !== null) task.tags.push('tm/' + quadrant);
    if (newRawLine !== null) task.rawLine = newRawLine;
    this.notify();
  }

  // ─── delete ───────────────────────────────────────────────────────────
  // Remove the task's line from its source file entirely. Conflict-checked
  // against the parsed rawLine so a shifted/edited line is never clobbered.
  // Offers an undo (re-insert the exact line) via the resulting Notice.
  async deleteTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const file = this.app.vault.getAbstractFileByPath(task.file);
    if (!(file instanceof TFile)) return;

    let conflict = false;
    let deletedLine: string | null = null;
    const lineIndex = task.lineNumber;
    try {
      await this.app.vault.process(file, (text) => {
        const lines = text.split('\n');
        if (lines[lineIndex] !== task.rawLine) { conflict = true; return text; }
        deletedLine = lines[lineIndex];
        lines.splice(lineIndex, 1);
        return lines.join('\n');
      });
    } catch (err) {
      new Notice(`TaskMatrix: failed to delete task — ${errMessage(err)}`);
      return;
    }

    if (conflict) {
      new Notice('TaskMatrix: file changed underneath — rescanning.');
      await this.refreshFile(file);
      return;
    }

    this.tasks.delete(taskId);
    this.notify();

    // Undo affordance — re-insert the removed line at its old index.
    const notice = new Notice('', 8000);
    notice.messageEl.setText('TaskMatrix: task deleted. ');
    const undoLink = notice.messageEl.createEl('a', { text: 'Undo', href: '#' });
    undoLink.addEventListener('click', (e) => {
      e.preventDefault();
      notice.hide();
      if (deletedLine === null) return;
      void this.app.vault.process(file, (text) => {
        const lines = text.split('\n');
        const at = Math.max(0, Math.min(lineIndex, lines.length));
        lines.splice(at, 0, deletedLine as string);
        return lines.join('\n');
      }).catch((err) => {
        new Notice(`TaskMatrix: undo failed — ${errMessage(err)}`);
      });
    });
  }

  // ─── archive ──────────────────────────────────────────────────────────
  // Write #tm/archived onto the source line (keeping the line) so the parser
  // drops it from the matrix. Returns true on success. Conflict-checked.
  async archiveTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    const file = this.app.vault.getAbstractFileByPath(task.file);
    if (!(file instanceof TFile)) return false;

    let conflict = false;
    try {
      await this.app.vault.process(file, (text) => {
        const lines = text.split('\n');
        const result = mutateArchive(lines[task.lineNumber], task.rawLine);
        if (result.conflict) { conflict = true; return text; }
        lines[task.lineNumber] = result.line as string;
        return lines.join('\n');
      });
    } catch (err) {
      new Notice(`TaskMatrix: failed to archive task — ${errMessage(err)}`);
      return false;
    }

    if (conflict) {
      new Notice('TaskMatrix: file changed underneath — rescanning.');
      await this.refreshFile(file);
      return false;
    }

    this.tasks.delete(taskId);
    this.notify();
    return true;
  }

  // Batch: archive every completed task in a quadrant (used by the Q4
  // "Archive completed" button). Each archive is its own vault.process call.
  async archiveCompletedInQuadrant(quadrant: Quadrant): Promise<number> {
    const ids = [...this.tasks.values()]
      .filter((t) => t.quadrant === quadrant && t.status === 'completed')
      .map((t) => t.id);
    let archived = 0;
    for (const id of ids) {
      if (await this.archiveTask(id)) archived++;
    }
    return archived;
  }

  // ─── inline text edit ───────────────────────────────────────────────────
  // Rewrite a task's body text in place, preserving the checkbox prefix and
  // trailing block ID (see mutateTaskText). Conflict-checked; empty text is
  // rejected without writing.
  async editTaskText(taskId: string, newText: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const file = this.app.vault.getAbstractFileByPath(task.file);
    if (!(file instanceof TFile)) return;

    let conflict = false;
    let invalid = false;
    let newRawLine: string | null = null;
    try {
      await this.app.vault.process(file, (text) => {
        const lines = text.split('\n');
        const result = mutateTaskText(lines[task.lineNumber], task.rawLine, newText);
        if (result.conflict) { conflict = true; return text; }
        if (result.line === null || result.line === undefined) { invalid = true; return text; }
        lines[task.lineNumber] = result.line;
        newRawLine = result.line;
        return lines.join('\n');
      });
    } catch (err) {
      new Notice(`TaskMatrix: failed to edit task — ${errMessage(err)}`);
      return;
    }

    if (conflict) {
      new Notice('TaskMatrix: file changed underneath — rescanning.');
      await this.refreshFile(file);
      return;
    }
    if (invalid) {
      new Notice('TaskMatrix: task text cannot be empty.');
      this.notify();
      return;
    }

    if (newRawLine !== null) task.rawLine = newRawLine;
    // The vault.process write fires a 'modify' event → refreshFile re-parses
    // and reconciles task.text; notify now so any open editor closes promptly.
    this.notify();
  }

  // ─── creation ─────────────────────────────────────────────────────────
  // Append a new pending task to the backlog note, creating the note if it
  // doesn't exist. The vault.on('create'/'modify') listeners refresh the
  // matrix; no manual rescan needed. We do not generate block IDs — the
  // source owns `^task-…`.
  async addTaskToBacklog(text: string): Promise<void> {
    const cleaned = text.replace(/\r\n|\r|\n/g, ' ').trim();
    if (!cleaned) return;

    const path = this.settings.backlogPath || DEFAULT_BACKLOG_PATH;
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      try {
        file = await this.app.vault.create(path, '# Task Backlog\n\n');
      } catch (err) {
        new Notice(`TaskMatrix: couldn't create ${path} — ${errMessage(err)}`);
        return;
      }
    }
    if (!(file instanceof TFile)) return;

    try {
      await this.app.vault.process(file, (content) => {
        const sep = content === '' || content.endsWith('\n') ? '' : '\n';
        return content + sep + `- [ ] ${cleaned} #task\n`;
      });
    } catch (err) {
      new Notice(`TaskMatrix: failed to add task — ${errMessage(err)}`);
      return;
    }
    new Notice(`TaskMatrix: added to ${path}.`);
  }

  openAddTaskModal(): void {
    new AddTaskModal(this.app, (text) => { void this.addTaskToBacklog(text); }).open();
  }

  // ─── view bookkeeping ───────────────────────────────────────────────────
  registerMatrixView(view: MatrixView): void { this.views.add(view); }
  unregisterMatrixView(view: MatrixView): void { this.views.delete(view); }

  notify(): void {
    for (const view of this.views) {
      try { view.render(); } catch (err) { console.error('[TaskMatrix] view render failed:', err); }
    }
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ─── view ───────────────────────────────────────────────────────────────
class MatrixView extends ItemView {
  plugin: TaskMatrixPlugin;
  filterStatus: string = 'all';
  searchTerm: string = '';
  draggingId: string | null = null;
  // Pending-render flag: a notify() during an in-flight drag would empty
  // the matrix bodies and destroy the dragged card under the user's
  // pointer. Buffer the render until dragend. (Reviewer H2.)
  pendingRender: boolean = false;

  constructor(leaf: WorkspaceLeaf, plugin: TaskMatrixPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return 'Task Matrix'; }
  getIcon(): string { return 'layout-grid'; }

  async onOpen(): Promise<void> {
    this.plugin.registerMatrixView(this);
    this.buildSkeleton();
    this.attachInteractions();
    this.render();
  }

  async onClose(): Promise<void> {
    this.plugin.unregisterMatrixView(this);
  }

  buildSkeleton(): void {
    const root = this.contentEl;
    root.empty();
    root.classList.add('task-matrix-root');

    const appEl = root.createDiv({ cls: 'tm-app' });

    // Toolbar.
    const toolbar = appEl.createEl('header', { cls: 'tm-toolbar' });
    const search = toolbar.createDiv({ cls: 'search' });
    appendSvg(search, 'ico-sm', (svg) => svgPath(svg, ICON_SEARCH));
    search.createEl('input', {
      cls: 'tm-search',
      attr: { type: 'search', placeholder: 'Filter tasks…', autocomplete: 'off', 'aria-label': 'Filter tasks' },
    });

    const filterBar = toolbar.createDiv({ cls: 'filter-bar' });
    const FILTERS: Array<{ key: string; label: string }> = [
      { key: 'all', label: 'All' },
      { key: 'pending', label: 'Pending' },
      { key: 'in_progress', label: 'In progress' },
      { key: 'completed', label: 'Completed' },
    ];
    for (const f of FILTERS) {
      filterBar.createEl('button', {
        cls: f.key === 'all' ? 'chip chip-active' : 'chip',
        text: f.label,
        attr: { 'data-filter': f.key },
      });
    }

    toolbar.createDiv({ cls: 'tm-toolbar-spacer' });
    toolbar.createEl('button', {
      cls: 'btn btn-ghost btn-sm tm-rescan',
      text: 'Rescan',
      attr: { type: 'button', title: 'Rescan vault' },
    });

    // Workspace: matrix + backlog.
    const workspace = appEl.createEl('section', { cls: 'workspace' });
    const matrix = workspace.createDiv({ cls: 'matrix', attr: { 'aria-label': 'Eisenhower Matrix' } });

    // Axes are direct grid children of .matrix (explicitly placed via CSS),
    // so no wrapper / display:contents is needed.
    const axisX = matrix.createDiv({ cls: 'axis-x' });
    axisX.createEl('span', { text: 'Urgent' });
    axisX.createEl('span', { text: 'Not Urgent' });
    const axisY = matrix.createDiv({ cls: 'axis-y' });
    axisY.createEl('span', { text: 'Important' });
    axisY.createEl('span', { text: 'Not Important' });

    const grid = matrix.createDiv({ cls: 'matrix-grid' });
    for (const q of QUAD_DEFS) {
      const article = grid.createEl('article', { cls: 'quad', attr: { 'data-quadrant': q.id } });
      const header = article.createEl('header');
      header.createEl('span', { cls: `quad-mark ${q.id}` });
      header.createEl('h2', { text: q.title });
      header.createEl('span', { cls: 'quad-meta', text: q.meta });
      header.createEl('span', { cls: 'quad-count', text: '0', attr: { 'data-count': q.id } });
      if (q.id === 'q4') {
        header.createEl('button', {
          cls: 'btn btn-ghost btn-sm quad-archive',
          text: 'Archive',
          attr: { type: 'button', 'data-action': 'archive-completed', 'data-quadrant': 'q4' },
        });
      }
      article.createDiv({ cls: 'quad-body', attr: { 'data-drop': q.id } });
    }

    const backlog = workspace.createEl('aside', { cls: 'backlog', attr: { 'aria-label': 'Backlog' } });
    const backlogHead = backlog.createEl('header', { cls: 'backlog-head' });
    const backlogTitle = backlogHead.createDiv({ cls: 'backlog-title' });
    backlogTitle.createEl('h2', { text: 'Backlog' });
    backlogTitle.createEl('span', { cls: 'quad-count', text: '0', attr: { 'data-count': 'backlog' } });
    const addBtn = backlogTitle.createEl('button', {
      cls: 'tm-add-task',
      attr: { type: 'button', title: 'Add task to backlog', 'aria-label': 'Add task to backlog' },
    });
    setIcon(addBtn, 'plus');
    backlog.createDiv({ cls: 'backlog-body', attr: { 'data-drop': 'backlog' } });
  }

  attachInteractions(): void {
    const root = this.contentEl;

    for (const chip of Array.from(root.querySelectorAll<HTMLElement>('.filter-bar .chip'))) {
      this.registerDomEvent(chip, 'click', () => {
        for (const c of Array.from(root.querySelectorAll('.filter-bar .chip'))) c.classList.remove('chip-active');
        chip.classList.add('chip-active');
        this.filterStatus = chip.dataset.filter || 'all';
        this.render();
      });
    }

    const search = root.querySelector('.tm-search') as HTMLInputElement;
    this.registerDomEvent(search, 'input', (e) => {
      this.searchTerm = (e.target as HTMLInputElement).value.trim().toLowerCase();
      this.render();
    });

    this.registerDomEvent(root.querySelector('.tm-rescan') as HTMLElement, 'click', async () => {
      await this.plugin.scanVault();
      new Notice(`TaskMatrix: ${this.plugin.tasks.size} task${this.plugin.tasks.size === 1 ? '' : 's'} indexed.`);
    });

    this.registerDomEvent(root.querySelector('.tm-add-task') as HTMLElement, 'click', () => {
      this.plugin.openAddTaskModal();
    });

    // Status cycle (delegated).
    this.registerDomEvent(root, 'click', (e) => {
      const target = e.target as HTMLElement;
      const btn = target.closest('[data-action="cycle-status"]');
      if (!btn) return;
      const card = btn.closest<HTMLElement>('.task');
      if (!card) return;
      const id = card.dataset.id as string;
      const t = this.plugin.tasks.get(id);
      if (!t) return;
      const next: TaskStatus = e.shiftKey
        ? (t.status === 'cancelled' ? 'pending' : 'cancelled')
        : (STATUS_CYCLE[t.status] || 'pending');
      void this.plugin.toggleStatus(id, next);
    });

    // Archive a single card (delegated).
    this.registerDomEvent(root, 'click', (e) => {
      const target = e.target as HTMLElement;
      const btn = target.closest('[data-action="archive-task"]');
      if (!btn) return;
      e.stopPropagation();
      const card = btn.closest<HTMLElement>('.task');
      if (!card) return;
      const id = card.dataset.id as string;
      void this.plugin.archiveTask(id);
    });

    // Delete a single card (delegated).
    this.registerDomEvent(root, 'click', (e) => {
      const target = e.target as HTMLElement;
      const btn = target.closest('[data-action="delete-task"]');
      if (!btn) return;
      e.stopPropagation();
      const card = btn.closest<HTMLElement>('.task');
      if (!card) return;
      const id = card.dataset.id as string;
      void this.plugin.deleteTask(id);
    });

    // Archive all completed tasks in the Delete quadrant (delegated).
    this.registerDomEvent(root, 'click', async (e) => {
      const target = e.target as HTMLElement;
      const btn = target.closest<HTMLButtonElement>('[data-action="archive-completed"]');
      if (!btn) return;
      const quadrant = (btn.dataset.quadrant as Quadrant) || 'q4';
      const count = [...this.plugin.tasks.values()]
        .filter((t) => t.quadrant === quadrant && t.status === 'completed').length;
      if (count === 0) {
        new Notice('No completed tasks to archive.');
        return;
      }
      new ConfirmModal(
        this.plugin.app,
        `Archive ${count} completed task${count === 1 ? '' : 's'}?`,
        'Their lines stay in your vault but stop showing in the matrix. Delete the #tm/archived tag in Obsidian to bring one back.',
        () => {
          btn.disabled = true;
          void this.plugin.archiveCompletedInQuadrant(quadrant)
            .then((archived) => {
              new Notice(`Archived ${archived} task${archived === 1 ? '' : 's'}.`);
            })
            .finally(() => {
              btn.disabled = false;
            });
        },
      ).open();
    });

    // Open source file (jumps to the task's line).
    this.registerDomEvent(root, 'click', (e) => {
      const target = e.target as HTMLElement;
      const link = target.closest<HTMLElement>('[data-action="open-file"]');
      if (!link) return;
      e.preventDefault();
      const path = link.dataset.path as string;
      const lineStr = link.dataset.line;
      const file = this.plugin.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return;
      const leaf = this.plugin.app.workspace.getLeaf(false);
      const eState = lineStr ? { line: Number(lineStr), col: 0 } : undefined;
      void leaf.openFile(file, eState ? { eState } : undefined);
    });

    // Double-click a card's text to edit it inline.
    this.registerDomEvent(root, 'dblclick', (e) => {
      const target = e.target as HTMLElement;
      const textEl = target.closest<HTMLElement>('.task-text');
      if (!textEl) return;
      const card = textEl.closest<HTMLElement>('.task');
      if (!card) return;
      e.preventDefault();
      this.beginInlineEdit(card, textEl, card.dataset.id as string);
    });

    // Drag and drop. Cards are draggable; quads and backlog are drop targets.
    // Backlog is grouped by file and not manually orderable; within a quad,
    // placement is a single markdown tag so order isn't tracked in v1.
    this.registerDomEvent(root, 'dragstart', (e) => {
      const target = e.target as HTMLElement;
      const card = target.closest<HTMLElement>('.task');
      if (!card) return;
      this.draggingId = card.dataset.id as string;
      card.classList.add('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', this.draggingId);
      }
    });

    this.registerDomEvent(root, 'dragend', () => {
      for (const el of Array.from(root.querySelectorAll('.task.is-dragging'))) el.classList.remove('is-dragging');
      for (const el of Array.from(root.querySelectorAll('.is-drop'))) el.classList.remove('is-drop');
      for (const el of Array.from(root.querySelectorAll('.drop-line'))) el.remove();
      this.draggingId = null;
      // Flush any render that arrived during the drag. (Reviewer H2.)
      if (this.pendingRender) {
        this.pendingRender = false;
        this.render();
      }
    });

    for (const target of Array.from(root.querySelectorAll<HTMLElement>('[data-drop]'))) {
      this.registerDomEvent(target, 'dragenter', (e) => {
        if (!this.draggingId) return;
        e.preventDefault();
        const host = target.closest('.quad') || target.closest('.backlog');
        if (host) host.classList.add('is-drop');
      });
      this.registerDomEvent(target, 'dragleave', (e) => {
        if (target.contains(e.relatedTarget as Node)) return;
        const host = target.closest('.quad') || target.closest('.backlog');
        if (host) host.classList.remove('is-drop');
        for (const el of Array.from(target.querySelectorAll(':scope > .drop-line'))) el.remove();
      });
      this.registerDomEvent(target, 'dragover', (e) => {
        if (!this.draggingId) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        // Within-quadrant order isn't a thing in v1, so we only highlight the
        // host (.is-drop on the quad/backlog) — no insertion line, since the
        // drop position would be a lie about where the card lands.
      });
      this.registerDomEvent(target, 'drop', async (e) => {
        if (!this.draggingId) return;
        e.preventDefault();
        const draggingId = this.draggingId;
        // Clear immediately so a fast release-and-redrag can't reuse the
        // stale ID before dragend fires (which is unreliable across browsers).
        this.draggingId = null;
        const dropZone = target.dataset.drop;
        if (dropZone === 'backlog') {
          await this.plugin.setQuadrant(draggingId, null);
          new Notice('Returned to backlog.');
        } else {
          // Within-quadrant ordering isn't tracked in v1 (placement is a
          // single tag in markdown); the drop zone is the only signal we use.
          await this.plugin.setQuadrant(draggingId, dropZone as Quadrant);
        }
      });
    }
  }

  // ─── render ─────────────────────────────────────────────────────────────
  render(): void {
    const root = this.contentEl;
    if (!root.querySelector('.tm-app')) return;

    // If a drag is in flight, defer the render. dragend will flush.
    if (this.draggingId) {
      this.pendingRender = true;
      return;
    }

    const matchesFilter = (t: Task): boolean => {
      if (this.filterStatus !== 'all' && t.status !== this.filterStatus) return false;
      if (this.searchTerm) {
        const haystack = (t.text + ' ' + t.file).toLowerCase();
        if (!haystack.includes(this.searchTerm)) return false;
      }
      return true;
    };

    // Bucket tasks by quadrant in a single pass.
    const buckets: Record<string, Task[]> = { q1: [], q2: [], q3: [], q4: [], backlog: [] };
    let placedCount = 0;
    for (const t of this.plugin.tasks.values()) {
      if (!matchesFilter(t)) continue;
      if (t.quadrant) {
        buckets[t.quadrant].push(t);
        placedCount++;
      } else {
        buckets.backlog.push(t);
      }
    }

    // Quadrants — sort by file then line so reorders are stable across rescans.
    for (const q of ['q1', 'q2', 'q3', 'q4']) {
      const body = root.querySelector(`[data-drop="${q}"]`) as HTMLElement;
      const count = root.querySelector(`[data-count="${q}"]`) as HTMLElement;
      body.empty();
      buckets[q].sort((a, b) => a.file.localeCompare(b.file) || a.lineNumber - b.lineNumber);
      for (const task of buckets[q]) body.appendChild(this.buildCard(task));
      count.textContent = String(buckets[q].length);
    }

    // Backlog (grouped by file).
    const backlogBody = root.querySelector('[data-drop="backlog"]') as HTMLElement;
    const backlogCount = root.querySelector('[data-count="backlog"]') as HTMLElement;
    backlogBody.empty();

    const backlog = buckets.backlog;
    backlog.sort((a, b) => a.file.localeCompare(b.file) || a.lineNumber - b.lineNumber);
    backlogCount.textContent = String(backlog.length);

    if (backlog.length === 0) {
      const empty = backlogBody.createDiv({ cls: 'tm-empty' });
      const total = this.plugin.tasks.size;
      const allPlaced = total > 0 && placedCount >= total;
      if (this.filterStatus !== 'all' || this.searchTerm) {
        empty.textContent = 'No tasks match the current filter.';
      } else if (total === 0) {
        empty.textContent = 'No #task lines detected. Add #task to a markdown checkbox line, then Rescan.';
      } else if (allPlaced) {
        empty.textContent = 'All detected tasks are placed in the matrix.';
      } else {
        empty.textContent = 'Backlog is empty.';
      }
    } else {
      const groups = new Map<string, Task[]>();
      for (const t of backlog) {
        if (!groups.has(t.file)) groups.set(t.file, []);
        (groups.get(t.file) as Task[]).push(t);
      }
      for (const [file, items] of groups) {
        const group = backlogBody.createDiv({ cls: 'file-group' });
        const head = group.createDiv({ cls: 'file-group-head' });
        appendSvg(head, 'ico-sm', (svg) => svgPath(svg, ICON_FILE));
        head.createEl('span', { cls: 'file-name', text: file });
        head.createEl('span', { cls: 'count', text: String(items.length) });
        for (const t of items) group.appendChild(this.buildCard(t));
      }
    }
  }

  // Swap a card's text for a textarea. Commit on Enter or blur, cancel on
  // Escape. The card is non-draggable while editing so a stray drag can't
  // tear out the field. A successful commit triggers a re-render via the
  // write's modify event; cancel/no-op restores the display directly.
  beginInlineEdit(card: HTMLElement, textEl: HTMLElement, id: string): void {
    const task = this.plugin.tasks.get(id);
    if (!task) return;
    if (textEl.querySelector('textarea')) return; // already editing

    const original = task.text;
    textEl.empty();
    const textarea = textEl.createEl('textarea', { cls: 'tm-edit-textarea' });
    textarea.value = original;
    card.draggable = false;

    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      card.draggable = true;
      const value = textarea.value;
      if (commit && value.trim() && value.trim() !== original.trim()) {
        void this.plugin.editTaskText(id, value);
        return; // re-render arrives from the write / modify event
      }
      this.render(); // cancel or no-op — rebuild the card as it was
    };

    this.registerDomEvent(textarea, 'keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    this.registerDomEvent(textarea, 'blur', () => finish(true));

    textarea.focus();
    textarea.select();
  }

  buildCard(task: Task): HTMLElement {
    const el = activeDocument.createElement('div');
    el.className = 'task';
    el.dataset.id = task.id;
    el.dataset.status = task.status;
    el.draggable = true;
    el.tabIndex = 0;

    // Status-cycle button.
    const check = el.createEl('button', {
      cls: 'task-check',
      attr: { 'aria-label': 'Cycle status (Shift+click to cancel)', 'data-action': 'cycle-status' },
    });
    appendSvg(check, '', (svg) => {
      const poly = activeDocument.createElementNS(SVG_NS, 'polyline');
      poly.setAttribute('points', '4,12 10,18 20,6');
      svg.appendChild(poly);
    });

    const body = el.createDiv({ cls: 'task-body' });

    // User content is always emitted via textContent / text nodes.
    const textEl = body.createDiv({ cls: 'task-text' });
    textEl.appendChild(renderText(task.text));

    const meta = body.createDiv({ cls: 'task-meta' });
    const link = meta.createEl('a', {
      cls: 'task-source',
      attr: { href: '#', 'data-action': 'open-file', title: 'Open in Obsidian' },
    });
    appendSvg(link, '', (svg) => svgPath(svg, ICON_FILE));
    const sourceName = link.createEl('span', { cls: 'task-source-name' });

    link.dataset.path = task.file;
    link.dataset.line = String(task.lineNumber);
    // Anchors are natively draggable as URLs and would compete with the
    // task-card drag, especially on WebKit. (Reviewer M3.)
    link.draggable = false;
    sourceName.textContent = task.file;

    for (const tag of task.tags) {
      // Hide the bookkeeping tags: `task` itself (it's the detection signal,
      // shown on every card and adds no info) and `tm/qN` (the quadrant is
      // already conveyed by which column the card lives in).
      if (tag === 'task') continue;
      if (QUAD_TAG_RE.test(tag)) continue;
      meta.createEl('span', { cls: 'task-tag', text: '#' + tag });
    }

    // Per-card actions: archive (keeps the line, adds #tm/archived) and
    // delete (removes the source line). Revealed on hover/focus via CSS.
    // Only offered for backlog and the Delete (q4) quadrant — once a task is
    // committed to Do / Schedule / Delegate (q1–q3) these are hidden, so the
    // path to removing it is to drag it to Delete (or back to the backlog).
    const showActions = !task.quadrant || task.quadrant === 'q4';
    if (showActions) {
      const actions = el.createDiv({ cls: 'task-actions' });
      const archiveBtn = actions.createEl('button', {
        cls: 'task-archive',
        attr: {
          type: 'button',
          'data-action': 'archive-task',
          title: 'Archive task (keeps the line, adds #tm/archived)',
          'aria-label': 'Archive task',
        },
      });
      setIcon(archiveBtn, 'archive');
      const deleteBtn = actions.createEl('button', {
        cls: 'task-delete',
        attr: {
          type: 'button',
          'data-action': 'delete-task',
          title: 'Delete task (removes the source line)',
          'aria-label': 'Delete task',
        },
      });
      setIcon(deleteBtn, 'x');
    }

    return el;
  }
}

// Render task body text into a DocumentFragment so user-vault content is
// always emitted via textContent (no innerHTML path). [[wikilinks]] and
// #hashtags become styled spans; everything else is a text node.
function renderText(raw: string): DocumentFragment {
  const frag = activeDocument.createDocumentFragment();
  let buf = '';
  const flush = (): void => {
    if (!buf) return;
    frag.appendChild(activeDocument.createTextNode(buf));
    buf = '';
  };
  let i = 0;
  while (i < raw.length) {
    if (raw.startsWith('[[', i)) {
      const end = raw.indexOf(']]', i + 2);
      if (end !== -1) {
        const inner = raw.slice(i + 2, end);
        const display = inner.includes('|')
          ? (inner.split('|').pop() as string)
          : (inner.split('#')[0].split('/').pop() as string);
        flush();
        const span = activeDocument.createElement('span');
        span.className = 'wikilink';
        span.textContent = display;
        frag.appendChild(span);
        i = end + 2;
        continue;
      }
    }
    if (raw[i] === '#' && /[A-Za-z]/.test(raw[i + 1] || '')) {
      let j = i + 1;
      while (j < raw.length && /[A-Za-z0-9_/-]/.test(raw[j])) j++;
      flush();
      const span = activeDocument.createElement('span');
      span.className = 'hashtag';
      span.textContent = raw.slice(i, j);
      frag.appendChild(span);
      i = j;
      continue;
    }
    buf += raw[i];
    i++;
  }
  flush();
  return frag;
}

// ─── modals ───────────────────────────────────────────────────────────────
// Add-task: a single text field that appends a pending task to the backlog
// note. Commit on Enter or the Add button; Escape (Obsidian default) closes.
class AddTaskModal extends Modal {
  private onSubmit: (text: string) => void;

  constructor(app: App, onSubmit: (text: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText('Add task to backlog');

    const input = contentEl.createEl('input', {
      cls: 'tm-add-input',
      attr: { type: 'text', placeholder: 'Task text…', 'aria-label': 'Task text' },
    });

    const submit = (): void => {
      const value = input.value.trim();
      if (!value) { input.focus(); return; }
      this.close();
      this.onSubmit(value);
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });

    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    buttons.createEl('button', { cls: 'mod-cta', text: 'Add task' })
      .addEventListener('click', submit);
    buttons.createEl('button', { text: 'Cancel' })
      .addEventListener('click', () => this.close());

    input.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// Confirm: a titled message with a confirm/cancel pair. Used before the
// batch archive action.
class ConfirmModal extends Modal {
  private titleText: string;
  private message: string;
  private confirmLabel: string;
  private onConfirm: () => void;

  constructor(app: App, title: string, message: string, onConfirm: () => void, confirmLabel = 'Archive') {
    super(app);
    this.titleText = title;
    this.message = message;
    this.onConfirm = onConfirm;
    this.confirmLabel = confirmLabel;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.titleText);
    contentEl.createEl('p', { text: this.message });

    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    buttons.createEl('button', { cls: 'mod-warning', text: this.confirmLabel })
      .addEventListener('click', () => { this.close(); this.onConfirm(); });
    buttons.createEl('button', { text: 'Cancel' })
      .addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ─── settings ─────────────────────────────────────────────────────────────
class TaskMatrixSettingTab extends PluginSettingTab {
  plugin: TaskMatrixPlugin;

  constructor(app: App, plugin: TaskMatrixPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Task detection')
      .setDesc('Which checkbox lines count as tasks. "Tagged" requires a #task tag; "All checkboxes" treats every checkbox line as a task.')
      .addDropdown((dd) => dd
        .addOption('tag', 'Tagged with #task')
        .addOption('open', 'All checkbox lines')
        .setValue(this.plugin.settings.detectionMode)
        .onChange(async (value) => {
          this.plugin.settings.detectionMode = value as DetectionMode;
          await this.plugin.saveSettings();
          await this.plugin.scanVault();
        }));

    new Setting(containerEl)
      .setName('Backlog note')
      .setDesc('New tasks from the + button and "Add task to backlog" command are appended here. Created if it does not exist.')
      .addText((text) => text
        .setPlaceholder(DEFAULT_BACKLOG_PATH)
        .setValue(this.plugin.settings.backlogPath)
        .onChange(async (value) => {
          this.plugin.settings.backlogPath = value.trim() || DEFAULT_BACKLOG_PATH;
          await this.plugin.saveSettings();
        }));
  }
}
