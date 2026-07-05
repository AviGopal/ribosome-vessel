export interface FsListTaskParams {
  path: string;
  glob: string;
  shuffle: boolean;
}

export interface JsonPathExtractTaskParams {
  sourceTaskId: string;
  jsonPath: string;
}

export interface FsReadTaskParams {
  pathFromTaskId: string;
}

export interface LlmCompletionDispatchTaskParams {
  sourceTaskId: string;
  requiredFields: string[];
  prBodyTrailer?: string;
}

export interface HttpFetchBodyTransform {
  goal: string;
  git: {
    cwd: string;
    owner: string;
    repo: string;
    base_branch: string;
    target_branch_template: string;
  };
}

export interface HttpFetchTaskParams {
  method: string;
  url: string;
  bodyFromTaskId: string;
  bodyTransform: HttpFetchBodyTransform;
}

export type TaskParams =
  | FsListTaskParams
  | JsonPathExtractTaskParams
  | FsReadTaskParams
  | LlmCompletionDispatchTaskParams
  | HttpFetchTaskParams;

export interface ComposeTask {
  id: string;
  type:
    | "fs_list"
    | "json_path_extract"
    | "fs_read"
    | "llm_completion_dispatch"
    | "http_fetch";
  params: TaskParams;
}

export interface ComposeDefinition {
  id: string;
  tags: string[];
  outputShape: string;
  tasks: ComposeTask[];
}
