export type EnvironmentType = 'venv' | 'conda' | 'poetry' | 'pipenv' | 'uv';

export interface Environment {
  id: string;
  name: string;
  path: string;
  type: EnvironmentType;
  pythonVersion: string;
  isActive: boolean;
}
