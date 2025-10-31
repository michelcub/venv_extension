import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { Environment, EnvironmentType } from './models';

const execFileAsync = promisify(execFile);

export async function detectEnvironments(): Promise<Environment[]> {
  const envs: Environment[] = [];

  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of workspaceFolders) {
    const folderPath = folder.uri.fsPath;
    const candidates = ['.venv', 'venv'];
    for (const dir of candidates) {
      const full = path.join(folderPath, dir);
      const env = await asVenv(full);
      if (env) envs.push(env);
    }
  }

  return dedupeByPath(envs);
}

async function asVenv(dir: string): Promise<Environment | null> {
  if (!existsDir(dir)) return null;
  const binDir = path.join(dir, 'bin');
  const py = [path.join(binDir, 'python3'), path.join(binDir, 'python')].find(existsFile);
  if (!py) return null;
  const version = await getPythonVersion(py);
  const name = path.basename(dir);
  return {
    id: dir,
    name,
    path: dir,
    type: 'venv',
    pythonVersion: version ?? 'unknown',
    isActive: false,
  };
}

function existsDir(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function existsFile(p: string | undefined): p is string {
  if (!p) return false;
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

async function getPythonVersion(pythonPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(pythonPath, ['-c', 'import platform; print(platform.python_version())']);
    return stdout.trim();
  } catch {
    try {
      const { stdout } = await execFileAsync(pythonPath, ['--version']);
      // output may be in stderr for some versions; handled below if needed
      return stdout.trim().split(/\s+/).pop() ?? null;
    } catch {
      return null;
    }
  }
}

function dedupeByPath(list: Environment[]): Environment[] {
  const seen = new Set<string>();
  const out: Environment[] = [];
  for (const e of list) {
    if (!seen.has(e.path)) {
      seen.add(e.path);
      out.push(e);
    }
  }
  return out;
}

export async function inspectEnvAtPath(dir: string, explicitType?: EnvironmentType): Promise<Environment | null> {
  if (!existsDir(dir)) return null;
  const binDir = path.join(dir, 'bin');
  const py = [path.join(binDir, 'python3'), path.join(binDir, 'python')].find(existsFile);
  if (!py) return null;
  const version = await getPythonVersion(py);
  const name = path.basename(dir);
  return {
    id: dir,
    name,
    path: dir,
    type: explicitType ?? 'venv',
    pythonVersion: version ?? 'unknown',
    isActive: false,
  };
}
