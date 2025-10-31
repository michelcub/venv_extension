import * as vscode from 'vscode';
import { listPackages, fetchPyPIInfo, detectUnusedPackages } from '../extension';

export class PackagesTreeDataProvider implements vscode.TreeDataProvider<PackageItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private context: vscode.ExtensionContext) {}

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: PackageItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<PackageItem[]> {
    const activeEnvPath = this.context.globalState.get<string | null>('activeEnvPath', null);
    if (!activeEnvPath) {
      return [new PackageItem('No hay entorno activo', '', true)];
    }
    try {
      const pkgs = await listPackages(activeEnvPath);
      const unused = await detectUnusedPackages(activeEnvPath);
      if (pkgs.length === 0) {
        return [new PackageItem('Sin paquetes', '', true)];
      }
      const items = await Promise.all(
        pkgs.map(async (p: { name: string; version: string }) => {
          try {
            const info = await fetchPyPIInfo(p.name);
            const latest = info?.info?.version as string | undefined;
            const outdated = !!latest && latest !== p.version;
            const isUnused = unused.has(p.name.toLowerCase());
            return new PackageItem(p.name, p.version, false, latest, outdated, isUnused);
          } catch {
            const isUnused = unused.has(p.name.toLowerCase());
            return new PackageItem(p.name, p.version, false, undefined, false, isUnused);
          }
        })
      );
      const outdatedCount = items.filter(i => i.contextValue === 'packageItemOutdated').length;
      const header: PackageItem[] = outdatedCount > 0
        ? [PackageItem.header(`${outdatedCount} actualizaciones disponibles`)]
        : [];
      return [...header, ...items];
    } catch (e: any) {
      return [new PackageItem(`Error: ${e?.message ?? e}`, '', true)];
    }
  }
}

export class PackageItem extends vscode.TreeItem {
  constructor(name: string, version: string, readonly disabled: boolean = false, latest?: string, outdated?: boolean, unused?: boolean) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.description = latest && outdated ? `${version} → ${latest}` : version;
    const baseTooltip = latest ? `${name}\nActual: ${version}\nÚltima: ${latest}` : `${name}\nActual: ${version}`;
    this.tooltip = unused ? `${baseTooltip}\nPosiblemente no usado` : baseTooltip;
    this.contextValue = disabled ? 'packageItemDisabled' : (outdated ? 'packageItemOutdated' : 'packageItem');
    // Icono: warning si es posiblemente no usado, flecha si desactualizado, paquete si normal
    this.iconPath = unused ? new vscode.ThemeIcon('warning') : (outdated ? new vscode.ThemeIcon('arrow-up') : new vscode.ThemeIcon('package'));
  }

  static header(text: string): PackageItem {
    const item = new PackageItem(text, '', true);
    item.contextValue = 'packageHeader';
    item.iconPath = new vscode.ThemeIcon('arrow-circle-up');
    return item;
  }
}
