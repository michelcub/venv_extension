import * as vscode from 'vscode';
import * as path from 'path';
import { detectEnvironments } from '../core/detectors';
import { Environment } from '../core/models';

export class VenvTreeDataProvider implements vscode.TreeDataProvider<VenvItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<VenvItem | undefined | void> = new vscode.EventEmitter<VenvItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<VenvItem | undefined | void> = this._onDidChangeTreeData.event;
  static readonly MANUAL_ENVS_KEY = 'manualEnvs';
  static readonly ACTIVE_ENV_PATH_KEY = 'activeEnvPath';
  private filterText: string | null = null;
  constructor(private context?: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  async getChildren(): Promise<VenvItem[]> {
    const detected: Environment[] = await detectEnvironments();
    const manual: Environment[] = this.context?.globalState.get<Environment[]>(VenvTreeDataProvider.MANUAL_ENVS_KEY, []) ?? [];
    const activePath = this.context?.globalState.get<string | null>(VenvTreeDataProvider.ACTIVE_ENV_PATH_KEY, null) ?? null;
    // Dedupe por ruta normalizada. Prioriza manual sobre detectado.
    const byPath = new Map<string, Environment>();
    for (const src of [manual, detected]) {
      for (const e of src) {
        const key = path.resolve(e.path);
        if (!byPath.has(key)) byPath.set(key, e);
      }
    }
    let envs = Array.from(byPath.values()).map(e => ({ ...e, isActive: path.resolve(e.path) === (activePath ? path.resolve(activePath) : activePath) }));
    if (this.filterText && this.filterText.trim()) {
      const f = this.filterText.toLowerCase();
      envs = envs.filter(e =>
        e.name.toLowerCase().includes(f) ||
        e.type.toLowerCase().includes(f) ||
        e.pythonVersion.toLowerCase().includes(f) ||
        e.path.toLowerCase().includes(f)
      );
    }
    return envs.map((e) => new VenvItem(e));
  }

  getTreeItem(element: VenvItem): vscode.TreeItem {
    return element;
  }

  async addManualEnv(env: Environment): Promise<void> {
    const manual: Environment[] = this.context?.globalState.get<Environment[]>(VenvTreeDataProvider.MANUAL_ENVS_KEY, []) ?? [];
    const exists = manual.some((e) => e.path === env.path);
    if (!exists) {
      const updated = [...manual, env];
      await this.context?.globalState.update(VenvTreeDataProvider.MANUAL_ENVS_KEY, updated);
      this.refresh();
    }
  }

  async setActiveEnv(path: string): Promise<void> {
    await this.context?.globalState.update(VenvTreeDataProvider.ACTIVE_ENV_PATH_KEY, path);
    this.refresh();
  }

  async clearActiveEnv(): Promise<void> {
    await this.context?.globalState.update(VenvTreeDataProvider.ACTIVE_ENV_PATH_KEY, null);
    this.refresh();
  }

  async removeManualEnvByPath(path: string): Promise<void> {
    const manual: Environment[] = this.context?.globalState.get<Environment[]>(VenvTreeDataProvider.MANUAL_ENVS_KEY, []) ?? [];
    const updated = manual.filter(e => e.path !== path);
    await this.context?.globalState.update(VenvTreeDataProvider.MANUAL_ENVS_KEY, updated);
    this.refresh();
  }

  isManualPath(path: string): boolean {
    const manual: Environment[] = this.context?.globalState.get<Environment[]>(VenvTreeDataProvider.MANUAL_ENVS_KEY, []) ?? [];
    return manual.some(e => e.path === path);
  }

  async setFilter(text: string | null) {
    this.filterText = text && text.trim() ? text : null;
    this.refresh();
  }
}

export class VenvItem extends vscode.TreeItem {
  constructor(public readonly env: Environment) {
    super(env.isActive ? `● ${env.name}` : env.name, vscode.TreeItemCollapsibleState.None);
    this.description = `${env.pythonVersion} • ${env.type}${env.isActive ? ' • activo' : ''}`;
    this.tooltip = env.path;
    this.contextValue = env.isActive ? 'venvItemActive' : 'venvItemInactive';
  }
}
