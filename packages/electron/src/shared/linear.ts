export interface LinearProject {
  id: string;
  name: string;
  description?: string | null;
  content?: string | null;
  url: string;
  state: string;
}

export interface LinearPage<T> {
  nodes: T[];
  nextCursor?: string;
}

export interface LinearProjectImportResult {
  projectId: string;
  name: string;
  workspacePath: string;
  created: number;
  skipped: number;
  errors: string[];
}
