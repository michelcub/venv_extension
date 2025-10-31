import * as vscode from 'vscode';
import { VenvTreeDataProvider, VenvItem } from './tree/VenvTreeDataProvider';
import { PackagesTreeDataProvider } from './tree/PackagesTreeDataProvider';
import { inspectEnvAtPath } from './core/detectors';
import { Environment, EnvironmentType } from './core/models';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const execFileAsync = promisify(execFile);

export function activate(context: vscode.ExtensionContext) {
  const treeDataProvider = new VenvTreeDataProvider(context);
  const packagesProvider = new PackagesTreeDataProvider(context);
  vscode.window.registerTreeDataProvider('venvExplorer', treeDataProvider);
  vscode.window.registerTreeDataProvider('venvPackages', packagesProvider);

  context.subscriptions.push(
    vscode.commands.registerCommand('venv.list', () => treeDataProvider.refresh()),
    vscode.commands.registerCommand('venv.create', async () => {
      await createEnvironmentFlow(treeDataProvider);
    }),
    vscode.commands.registerCommand('venv.activate', async (item: VenvItem) => {
      if (!item?.env?.path) return;
      await (treeDataProvider as any).setActiveEnv(item.env.path);
      await prepareTerminalForEnv(item.env.path);
      await setWorkspaceInterpreter(item.env.path);
      await setInterpreterViaPythonExtension(item.env.path);
      vscode.window.showInformationMessage(`Entorno activado: ${item.env.name}`);
      packagesProvider.refresh();
    }),
    vscode.commands.registerCommand('venv.deactivate', async () => {
      await (treeDataProvider as any).clearActiveEnv();
      vscode.window.showInformationMessage('Entorno desactivado');
    }),
    vscode.commands.registerCommand('venv.packages', async () => {
      const envPath = getActiveEnvPathLocal(context);
      if (!envPath) {
        vscode.window.showWarningMessage('No hay entorno activo. Activa un entorno para ver sus paquetes.');
        return;
      }

      try {
        const items = await listPackages(envPath);
        const picked = await vscode.window.showQuickPick(
          items.map((p: { name: string; version: string }) => ({ label: p.name, description: p.version })),
          { title: 'Paquetes instalados', matchOnDescription: true, canPickMany: false }
        );
        // futuro: abrir PyPI del paquete seleccionado
      } catch (e: any) {
        vscode.window.showErrorMessage(`Error obteniendo paquetes: ${e?.message ?? e}`);
      }
    }),
    vscode.commands.registerCommand('venv.install', async () => {
      const envPath = getActiveEnvPathLocal(context);
      if (!envPath) {
        vscode.window.showWarningMessage('No hay entorno activo. Activa un entorno para instalar paquetes.');
        return;
      }
      const pkgName = await vscode.window.showInputBox({ title: 'Paquete a instalar (PyPI)', placeHolder: 'ej: requests' });
      if (!pkgName) return;
      try {
        const info = await fetchPyPIInfo(pkgName.trim());
        if (!info) {
          vscode.window.showErrorMessage(`No se encontró el paquete ${pkgName} en PyPI.`);
          return;
        }
        const pickedVersion2 = await pickVersion(info);
        if (!pickedVersion2) return;
        const spec = `${info.info.name}==${pickedVersion2}`;
        await installPackage(envPath, spec);
        vscode.window.showInformationMessage(`Instalado: ${spec}`);
        packagesProvider.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Error instalando paquete: ${e?.message ?? e}`);
      }
    }),
    // Packages view toolbar commands
    vscode.commands.registerCommand('venv.packages.refresh', async () => {
      packagesProvider.refresh();
    }),
    vscode.commands.registerCommand('venv.packages.search', async () => {
      const envPath = getActiveEnvPathLocal(context);
      if (!envPath) { vscode.window.showWarningMessage('Activa un entorno para buscar paquetes.'); return; }
      const name = await vscode.window.showInputBox({ title: 'Buscar paquete en PyPI', placeHolder: 'ej: requests' });
      if (!name) return;
      const info = await fetchPyPIInfo(name.trim());
      if (!info) { vscode.window.showWarningMessage('Paquete no encontrado en PyPI'); return; }
      const pickedVersion = await pickVersion(info);
      if (!pickedVersion) return;
      const spec = `${info.info.name}==${pickedVersion}`;
      await installPackage(envPath, spec);
      vscode.window.showInformationMessage(`Instalado: ${spec}`);
      packagesProvider.refresh();
    }),
    vscode.commands.registerCommand('venv.packages.add', async () => {
      // Alias simple a instalar
      await vscode.commands.executeCommand('venv.install');
    }),
    vscode.commands.registerCommand('venv.packages.uninstall', async (item: any) => {
      const envPath = getActiveEnvPathLocal(context);
      if (!envPath) { vscode.window.showWarningMessage('Activa un entorno para desinstalar paquetes.'); return; }
      const name = item?.label || (await vscode.window.showInputBox({ title: 'Paquete a desinstalar', placeHolder: 'ej: requests' }));
      if (!name) return;
      const answer = await vscode.window.showWarningMessage(`¿Desinstalar ${name}?`, { modal: true }, 'Desinstalar');
      if (answer !== 'Desinstalar') return;
      try {
        await pipUninstall(envPath, String(name));
        vscode.window.showInformationMessage(`Desinstalado: ${name}`);
        packagesProvider.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Error desinstalando paquete: ${e?.message ?? e}`);
      }
    }),
    vscode.commands.registerCommand('venv.packages.update', async (item: any) => {
      const envPath = getActiveEnvPathLocal(context);
      if (!envPath) { vscode.window.showWarningMessage('Activa un entorno para actualizar paquetes.'); return; }
      const name = item?.label || (await vscode.window.showInputBox({ title: 'Paquete a actualizar', placeHolder: 'ej: requests' }));
      if (!name) return;
      try {
        await pipUpgrade(envPath, String(name));
        vscode.window.showInformationMessage(`Actualizado: ${name}`);
        packagesProvider.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Error actualizando paquete: ${e?.message ?? e}`);
      }
    }),
    vscode.commands.registerCommand('venv.packages.updateAll', async () => {
      const envPath = getActiveEnvPathLocal(context);
      if (!envPath) { vscode.window.showWarningMessage('Activa un entorno para actualizar paquetes.'); return; }
      try {
        const pkgs = await listPackages(envPath);
        // Determine outdated by comparing to PyPI latest
        const withLatest = await Promise.all(pkgs.map(async p => {
          const info = await fetchPyPIInfo(p.name);
          const latest = info?.info?.version as string | undefined;
          return { ...p, latest };
        }));
        const outdated = withLatest.filter(p => p.latest && p.latest !== p.version) as Array<{ name: string; version: string; latest: string }>;
        if (outdated.length === 0) { vscode.window.showInformationMessage('No hay paquetes para actualizar.'); return; }
        const confirm = await vscode.window.showWarningMessage(`Actualizar ${outdated.length} paquetes a latest?`, { modal: true }, 'Actualizar');
        if (confirm !== 'Actualizar') return;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Actualizando ${outdated.length} paquetes...`, cancellable: false }, async progress => {
          let done = 0;
          for (const p of outdated) {
            progress.report({ message: `${p.name} ${p.version} → ${p.latest}`, increment: (1 / outdated.length) * 100 });
            await pipUpgrade(envPath, p.name);
            done++;
          }
        });
        vscode.window.showInformationMessage(`Actualizados ${outdated.length} paquetes.`);
        packagesProvider.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Error en actualización masiva: ${e?.message ?? e}`);
      }
    }),
    vscode.commands.registerCommand('venv.importReqs', async () => {
      const envPath = getActiveEnvPathLocal(context);
      if (!envPath) { vscode.window.showWarningMessage('Activa un entorno para importar requirements.'); return; }
      try {
        const fileUris = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: 'Seleccionar requirements.txt',
          filters: { 'Text': ['txt'], 'Todos': ['*'] }
        });
        if (!fileUris || !fileUris[0]) return;
        const reqPath = fileUris[0].fsPath;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Instalando dependencias', cancellable: false }, async progress => {
          progress.report({ message: 'pip install -r requirements.txt' });
          await importRequirements(envPath, reqPath);
        });
        vscode.window.showInformationMessage('Dependencias instaladas desde requirements.txt');
        packagesProvider.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Error importando requirements: ${e?.message ?? e}`);
      }
    }),
    vscode.commands.registerCommand('venv.exportReqs', async () => {
      const envPath = getActiveEnvPathLocal(context);
      if (!envPath) { vscode.window.showWarningMessage('Activa un entorno para exportar requirements.'); return; }
      try {
        const folders = vscode.workspace.workspaceFolders;
        const defaultUri = folders && folders[0] ? folders[0].uri.with({ path: require('path').join(folders[0].uri.fsPath, 'requirements.txt') }) : undefined;
        const uri = await vscode.window.showSaveDialog({ saveLabel: 'Guardar requirements.txt', defaultUri, filters: { 'Text': ['txt'] } });
        if (!uri) return;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Exportando requirements', cancellable: false }, async progress => {
          progress.report({ message: 'pip freeze > requirements.txt' });
          const content = await exportRequirements(envPath);
          await fs.promises.writeFile(uri.fsPath, content, 'utf8');
        });
        vscode.window.showInformationMessage(`Exportado a ${uri.fsPath}`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Error exportando requirements: ${e?.message ?? e}`);
      }
    }),
    vscode.commands.registerCommand('venv.filter', async () => {
      const text = await vscode.window.showInputBox({ title: 'Filtrar entornos', placeHolder: 'Nombre, tipo, versión o ruta' });
      await (treeDataProvider as any).setFilter(text ?? null);
    }),
    vscode.commands.registerCommand('venv.clearFilter', async () => {
      await (treeDataProvider as any).setFilter(null);
    }),
    vscode.commands.registerCommand('venv.delete', async (item: VenvItem) => {
      await deleteEnvironment(treeDataProvider, item);
    })
  );
}

export function deactivate() {}

async function createEnvironmentFlow(tree: VenvTreeDataProvider) {
  const kind = await vscode.window.showQuickPick(
    [
      { label: 'Python venv', detail: 'Crea un entorno usando python -m venv', value: 'venv' as EnvironmentType },
      { label: 'Poetry', detail: 'Usa Poetry para administrar el entorno', value: 'poetry' as EnvironmentType },
      { label: 'uv', detail: 'Crea/gestiona entorno con uv', value: 'uv' as EnvironmentType },
      { label: 'Seleccionar existente', detail: 'Añadir un entorno ya creado', value: 'select' as any },
    ],
    { title: 'Tipo de entorno', placeHolder: 'Selecciona cómo crear o seleccionar un entorno' }
  );
  if (!kind) return;

  if ((kind as any).value === 'select') {
    await selectExistingEnv(tree);
    return;
  }

  switch ((kind as any).value as EnvironmentType) {
    case 'venv':
      await createVenv(tree);
      break;
    case 'poetry':
      await createPoetryEnv(tree);
      break;
    case 'uv':
      await createUvEnv(tree);
      break;
    default:
      break;
  }
}

async function selectExistingEnv(tree: VenvTreeDataProvider) {
  const dirUris = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Seleccionar carpeta de entorno' });
  if (!dirUris || !dirUris[0]) return;
  const env = await inspectEnvAtPath(dirUris[0].fsPath);
  if (!env) {
    vscode.window.showErrorMessage('No se detectó un ejecutable de Python en bin/. Selecciona una carpeta de entorno válida.');
    return;
  }
  await tree.addManualEnv(env);
  vscode.window.showInformationMessage(`Entorno agregado: ${env.name}`);
}

async function createVenv(tree: VenvTreeDataProvider) {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const baseDir = await pickFolder(workspace, 'Selecciona la carpeta del proyecto donde crear el entorno');
  if (!baseDir) return;
  const name = await vscode.window.showInputBox({ title: 'Nombre del entorno', value: '.venv', validateInput: v => (!v ? 'Requerido' : undefined) });
  if (!name) return;
  const python = await vscode.window.showInputBox({ title: 'Ruta a python (opcional)', placeHolder: 'Ej: /usr/bin/python3 (vacío para python3)' });
  const pythonCmd = python && python.trim().length > 0 ? python.trim() : 'python3';
  const target = vscode.Uri.file(require('path').join(baseDir, name));

  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Creando venv', cancellable: false }, async progress => {
    progress.report({ message: 'Ejecutando python -m venv ...' });
    await execFileAsync(pythonCmd, ['-m', 'venv', target.fsPath]);
  });

  const env = await inspectEnvAtPath(target.fsPath, 'venv');
  if (!env) {
    vscode.window.showErrorMessage('No se pudo inspeccionar el entorno creado.');
    return;
  }
  await tree.addManualEnv(env);
  vscode.window.showInformationMessage(`Entorno venv creado en ${env.path}`);
}

async function createPoetryEnv(tree: VenvTreeDataProvider) {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const projectDir = await pickFolder(workspace, 'Selecciona la carpeta del proyecto (Pyproject/Poetry)');
  if (!projectDir) return;
  const python = await vscode.window.showInputBox({ title: 'Ruta a python (opcional)', placeHolder: 'Ej: /usr/bin/python3' });

  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Creando entorno con Poetry', cancellable: false }, async progress => {
    if (python && python.trim()) {
      progress.report({ message: 'poetry env use' });
      await execFileAsync('poetry', ['env', 'use', python.trim()], { cwd: projectDir });
    }
    progress.report({ message: 'poetry install (si aplica)' });
    try { await execFileAsync('poetry', ['install'], { cwd: projectDir }); } catch { /* ignore if no pyproject */ }
  });

  // Poetry suele crear .venv si está configurado; para MVP buscamos .venv
  const candidate = require('path').join(projectDir, '.venv');
  const env = await inspectEnvAtPath(candidate, 'poetry');
  if (!env) {
    vscode.window.showWarningMessage('No se encontró .venv. Asegura poetry.config.virtualenvs.in-project=true o agrega el entorno manualmente.');
    return;
  }
  await tree.addManualEnv(env);
  vscode.window.showInformationMessage(`Entorno Poetry agregado: ${env.path}`);
}

async function createUvEnv(tree: VenvTreeDataProvider) {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const projectDir = await pickFolder(workspace, 'Selecciona la carpeta del proyecto (uv)');
  if (!projectDir) return;
  const target = vscode.Uri.file(require('path').join(projectDir, '.venv'));

  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Creando entorno con uv', cancellable: false }, async progress => {
    progress.report({ message: 'uv venv' });
    try {
      await execFileAsync('uv', ['venv', target.fsPath], { cwd: projectDir });
    } catch {
      // como alternativa, uv sync puede crear el entorno si hay pyproject
      await execFileAsync('uv', ['sync'], { cwd: projectDir });
    }
  });

  const env = await inspectEnvAtPath(target.fsPath, 'uv');
  if (!env) {
    vscode.window.showErrorMessage('No se pudo detectar el entorno uv en .venv');
    return;
  }
  await tree.addManualEnv(env);
  vscode.window.showInformationMessage(`Entorno uv creado/agregado: ${env.path}`);
}

async function pickFolder(defaultDir: string | undefined, title: string): Promise<string | undefined> {
  const uri = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title, defaultUri: defaultDir ? vscode.Uri.file(defaultDir) : undefined });
  return uri && uri[0] ? uri[0].fsPath : undefined;
}

async function prepareTerminalForEnv(envPath: string) {
  const path = require('path');
  const binDir = path.join(envPath, 'bin');
  const shellEnv: { [key: string]: string } = { ...process.env } as any;
  const sep = process.platform === 'win32' ? ';' : ':';
  const pathVar = process.platform === 'win32' ? 'Path' : 'PATH';
  shellEnv[pathVar] = `${binDir}${sep}${shellEnv[pathVar] ?? ''}`;
  shellEnv['VIRTUAL_ENV'] = envPath;

  const term = vscode.window.createTerminal({
    name: 'Python Env',
    env: shellEnv,
  });
  term.show();
}

async function deleteEnvironment(tree: VenvTreeDataProvider, item: VenvItem) {
  if (!item?.env) return;
  const env = item.env;
  if (env.isActive) {
    vscode.window.showWarningMessage('No puedes eliminar el entorno activo. Desactívalo primero.');
    return;
  }
  const answer = await vscode.window.showWarningMessage(
    `¿Eliminar el entorno "${env.name}" en ${env.path}? Esta acción no se puede deshacer.`,
    { modal: true },
    'Eliminar'
  );
  if (answer !== 'Eliminar') return;

  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Eliminando entorno', cancellable: false }, async progress => {
    progress.report({ message: 'Eliminando directorio del entorno...' });
    try {
      await require('fs').promises.rm(env.path, { recursive: true, force: true });
    } catch (e) {
      // si falla el rm, informamos pero continuamos limpiando el listado manual
      console.error(e);
    }
    // quitar de la lista manual si estaba agregado manualmente
    if ((tree as any).isManualPath && (tree as any).removeManualEnvByPath) {
      if ((tree as any).isManualPath(env.path)) {
        await (tree as any).removeManualEnvByPath(env.path);
      } else {
        // si no era manual, solo refrescamos para que desaparezca si la detección ya no lo encuentra
        (tree as any).refresh();
      }
    } else {
      (tree as any).refresh();
    }
  });

  vscode.window.showInformationMessage(`Entorno eliminado: ${env.name}`);
}

// Helpers for HU-005/HU-006
function getActiveEnvPathLocal(context: vscode.ExtensionContext): string | null {
  const ACTIVE_KEY = 'activeEnvPath';
  return context.globalState.get<string | null>(ACTIVE_KEY, null) ?? null;
}

function getPythonFromEnv(envPath: string): string | null {
  const candidates = [path.join(envPath, 'bin', 'python3'), path.join(envPath, 'bin', 'python')];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

export async function listPackages(envPath: string): Promise<Array<{ name: string; version: string }>> {
  const py = getPythonFromEnv(envPath);
  if (!py) throw new Error('No se encontró ejecutable de Python en el entorno.');
  const { stdout } = await execFileAsync(py, ['-m', 'pip', 'list', '--format=json']);
  const parsed = JSON.parse(stdout || '[]');
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((x: any) => ({ name: String(x.name), version: String(x.version) }))
    .sort((a: any, b: any) => a.name.localeCompare(b.name));
}

// Heurística para detectar paquetes posiblemente no usados en el workspace actual.
// 1) Desde el entorno activo, obtener mapping módulo->distribución con importlib.metadata
// 2) Escanear archivos .py del workspace buscando imports
// 3) Marcar distribuciones cuyos módulos top-level no se importan en el código
export async function detectUnusedPackages(envPath: string): Promise<Set<string>> {
  const py = getPythonFromEnv(envPath);
  if (!py) return new Set<string>();
  // Paso 1: mapping módulo->distribución
  const code = `
import json
try:
  from importlib.metadata import packages_distributions
except Exception:
  try:
    from importlib_metadata import packages_distributions  # type: ignore
  except Exception:
    print(json.dumps({})); raise SystemExit(0)
mapping = packages_distributions() or {}
# invertimos: dist -> set(mods)
dist_to_mods = {}
for mod, dists in mapping.items():
    for d in dists or []:
        dist_to_mods.setdefault(d.lower(), set()).add(mod.split('.')[0])
out = {k: sorted(list(v)) for k, v in dist_to_mods.items()}
print(json.dumps(out))
`;
  let distToMods: Record<string, string[]> = {};
  try {
    const { stdout } = await execFileAsync(py, ['-c', code]);
    distToMods = JSON.parse(stdout || '{}');
  } catch {
    distToMods = {};
  }
  // Paso 2: escanear imports en el workspace
  const usedModules = new Set<string>();
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    try {
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/*.py'),
        new vscode.RelativePattern(folder, '{**/.venv/**,**/venv/**,**/__pycache__/**,**/node_modules/**,**/dist/**,**/build/**}'),
        2000
      );
      for (const file of files) {
        try {
          const doc = await vscode.workspace.openTextDocument(file);
          const text = doc.getText();
          const re = /^(?:from\s+([a-zA-Z_][\w]*)\s+import|import\s+([a-zA-Z_][\w]*))/gm;
          let m: RegExpExecArray | null;
          while ((m = re.exec(text))) {
            const mod = (m[1] || m[2] || '').split('.')[0];
            if (mod) usedModules.add(mod);
          }
        } catch {}
      }
    } catch {}
  }
  // Paso 3: marcar distribuciones no usadas
  const unused = new Set<string>();
  for (const [dist, mods] of Object.entries(distToMods)) {
    if (!mods || mods.length === 0) continue;
    const anyUsed = mods.some(m => usedModules.has(m));
    if (!anyUsed) unused.add(dist);
  }
  return unused;
}

export async function fetchPyPIInfo(packageName: string): Promise<any | null> {
  const https = require('https');
  const url = `https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`;
  return new Promise((resolve) => {
    https
      .get(url, (res: any) => {
        if (res.statusCode !== 200) {
          resolve(null);
          res.resume();
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch {
            resolve(null);
          }
        });
      })
      .on('error', () => resolve(null));
  });
}

async function installPackage(envPath: string, spec: string): Promise<void> {
  const py = getPythonFromEnv(envPath);
  if (!py) throw new Error('No se encontró ejecutable de Python en el entorno.');
  await execFileAsync(py, ['-m', 'pip', 'install', spec]);
}

async function importRequirements(envPath: string, requirementsPath: string): Promise<void> {
  const py = getPythonFromEnv(envPath);
  if (!py) throw new Error('No se encontró ejecutable de Python en el entorno.');
  await execFileAsync(py, ['-m', 'pip', 'install', '-r', requirementsPath]);
}

async function exportRequirements(envPath: string): Promise<string> {
  const py = getPythonFromEnv(envPath);
  if (!py) throw new Error('No se encontró ejecutable de Python en el entorno.');
  const { stdout } = await execFileAsync(py, ['-m', 'pip', 'freeze']);
  return stdout || '';
}

async function pickVersion(info: any): Promise<string | undefined> {
  const latest = info?.info?.version as string | undefined;
  const versions = Object.keys(info?.releases || {});
  // Ensure latest first
  const sorted = [latest, ...versions.filter(v => v !== latest)].filter(Boolean) as string[];
  const qp = vscode.window.createQuickPick<{ label: string; description?: string }>();
  qp.title = `Selecciona versión para ${info?.info?.name}`;
  qp.items = sorted.map(v => ({ label: v, description: v === latest ? 'latest' : undefined }));
  if (sorted.length > 0) {
    qp.activeItems = [qp.items[0]];
    qp.selectedItems = [qp.items[0]] as any;
  }
  return await new Promise((resolve) => {
    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0];
      qp.hide();
      resolve(sel?.label);
    });
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
}

async function pipUninstall(envPath: string, name: string): Promise<void> {
  const py = getPythonFromEnv(envPath);
  if (!py) throw new Error('No se encontró ejecutable de Python en el entorno.');
  await execFileAsync(py, ['-m', 'pip', 'uninstall', '-y', name]);
}

async function pipUpgrade(envPath: string, name: string): Promise<void> {
  const py = getPythonFromEnv(envPath);
  if (!py) throw new Error('No se encontró ejecutable de Python en el entorno.');
  await execFileAsync(py, ['-m', 'pip', 'install', '--upgrade', name]);
}

async function setWorkspaceInterpreter(envPath: string) {
  const pythonPath = getPythonFromEnv(envPath);
  if (!pythonPath) return;
  const folders = vscode.workspace.workspaceFolders ?? [];
  const targetFolder = folders.find(f => envPath.startsWith(f.uri.fsPath)) ?? folders[0];
  const config = vscode.workspace.getConfiguration('python', targetFolder?.uri);
  await config.update('defaultInterpreterPath', pythonPath, vscode.ConfigurationTarget.Workspace);
}

async function setInterpreterViaPythonExtension(envPath: string) {
  try {
    const pythonPath = getPythonFromEnv(envPath);
    if (!pythonPath) return;
    // Try common commands exposed by Python extension variants
    const commands = [
      'python.setInterpreter',
      'Python: Select Interpreter',
      'python.interpreter.setInterpreter',
    ];
    for (const cmd of commands) {
      try {
        await vscode.commands.executeCommand(cmd, { path: pythonPath });
        break;
      } catch {}
    }
  } catch {}
}

// Debounce utility for live search
function debounce<F extends (value: string) => any>(fn: F, wait: number) {
  let timer: NodeJS.Timeout | undefined;
  return (value: string) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(value), wait);
  };
}

// Simple PyPI search: fetch search HTML and extract top project names, then enrich with JSON info
async function searchPyPI(query: string): Promise<Array<{ name: string; version: string; summary: string }>> {
  const https = require('https');
  const url = `https://pypi.org/search/?q=${encodeURIComponent(query)}`;
  const html: string = await new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; VSCode-Extension-PyPI-Search)'
      }
    }, (res: any) => {
      if (res.statusCode !== 200) { resolve(''); res.resume(); return; }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(''));
  });
  if (!html) return [];
  // Try to extract names from class-based spans first
  const names: string[] = [];
  const nameRe = /class=\"package-snippet__name\"[^>]*>([^<]+)<\/span>/g;
  let nm: RegExpExecArray | null;
  while ((nm = nameRe.exec(html)) && names.length < 10) {
    const found = nm[1].trim();
    if (!names.includes(found)) names.push(found);
  }
  // Fallback: links to /project/<name>/
  if (names.length === 0) {
    const linkRe = /href=\"\/project\/([A-Za-z0-9_.\-]+)\//g;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html)) && names.length < 10) {
      const n = m[1];
      if (!names.includes(n)) names.push(n);
    }
  }
  // Second fallback: legacy pypi.python.org search page
  if (names.length === 0) {
    const https = require('https');
    const legacyUrl = `https://pypi.python.org/pypi?%3Aaction=search&term=${encodeURIComponent(query)}&submit=search`;
    const legacyHtml: string = await new Promise((resolve) => {
      const req2 = https.get(legacyUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VSCode-Extension-PyPI-Search)' }
      }, (res: any) => {
        if (res.statusCode !== 200) { resolve(''); res.resume(); return; }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => resolve(data));
      });
      req2.on('error', () => resolve(''));
    });
    if (legacyHtml) {
      const re2 = /href=\"\/pypi\/([A-Za-z0-9_.\-]+)\"/g;
      let m2: RegExpExecArray | null;
      while ((m2 = re2.exec(legacyHtml)) && names.length < 10) {
        const n2 = m2[1];
        if (!names.includes(n2)) names.push(n2);
      }
    }
  }
  const results: Array<{ name: string; version: string; summary: string }> = [];
  for (const name of names) {
    const info = await fetchPyPIInfo(name);
    if (info) {
      results.push({ name: info.info.name, version: info.info.version, summary: info.info.summary || '' });
    }
  }
  return results;
}
