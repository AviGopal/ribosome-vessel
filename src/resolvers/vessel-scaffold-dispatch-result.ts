import type { ResolverResult } from "../types/resolver";
import { vesselAuthoringScenarioConsumer } from "../composes";
import type { ComposeDefinition, FsListTaskParams, JsonPathExtractTaskParams, FsReadTaskParams, LlmCompletionDispatchTaskParams, HttpFetchTaskParams } from "../types/compose";

const GOAL_HOST_VESSEL_ENDPOINT = process.env.GOAL_HOST_VESSEL_ENDPOINT ?? "http://127.0.0.1:8210";

interface TaskResultMap {
  [taskId: string]: unknown;
}

interface VesselFields {
  vessel_name: string;
  port: number | string;
  advertised_shapes_literal: string;
  description: string;
  commit_message: string;
  pr_title: string;
  pr_body: string;
}

function isVesselFields(v: unknown): v is VesselFields {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj["vessel_name"] === "string" &&
    typeof obj["description"] === "string" &&
    typeof obj["commit_message"] === "string" &&
    typeof obj["pr_title"] === "string" &&
    typeof obj["pr_body"] === "string"
  );
}

function matchGlob(filename: string, glob: string): boolean {
  if (glob === "*") return true;
  if (glob.startsWith("*.")) {
    const ext = glob.slice(1);
    return filename.endsWith(ext);
  }
  if (glob.startsWith("*")) {
    return filename.endsWith(glob.slice(1));
  }
  if (glob.endsWith("*")) {
    return filename.startsWith(glob.slice(0, -1));
  }
  return filename === glob;
}

async function runFsList(params: FsListTaskParams): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(params.path);
  const filtered = entries.filter((e) => {
    try {
      return matchGlob(e, params.glob);
    } catch {
      return e.endsWith(".json");
    }
  }).map((e) => `${params.path}/${e}`);

  if (params.shuffle) {
    for (let i = filtered.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const iVal = filtered[i];
      const jVal = filtered[j];
      if (iVal !== undefined && jVal !== undefined) {
        filtered[i] = jVal;
        filtered[j] = iVal;
      }
    }
  }
  return filtered;
}

async function runJsonPathExtract(params: JsonPathExtractTaskParams, results: TaskResultMap): Promise<unknown> {
  const source = results[params.sourceTaskId];
  if (!Array.isArray(source)) throw new Error("json_path_extract source is not an array");
  const indexMatch = params.jsonPath.match(/\$\[(\d+)\]/);
  if (indexMatch) {
    const idxStr = indexMatch[1];
    if (idxStr === undefined) throw new Error("json_path_extract: invalid index match");
    const idx = parseInt(idxStr, 10);
    return source[idx];
  }
  return source[0];
}

async function runFsRead(params: FsReadTaskParams, results: TaskResultMap): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const filePath = results[params.pathFromTaskId];
  if (typeof filePath !== "string") throw new Error("fs_read: path must be a string");
  return readFile(filePath, "utf-8");
}

async function runLlmCompletionDispatch(
  params: LlmCompletionDispatchTaskParams,
  results: TaskResultMap
): Promise<VesselFields> {
  const scenarioContent = results[params.sourceTaskId];
  if (typeof scenarioContent !== "string") throw new Error("llm_completion_dispatch: source must be a string");

  const systemPrompt = [
    "You are a vessel authoring assistant. Given a scenario specification, emit a JSON object with EXACTLY these fields:",
    params.requiredFields.join(", "),
    params.prBodyTrailer ? `The pr_body field MUST end with the trailer: ${params.prBodyTrailer}` : "",
    "Respond with ONLY valid JSON, no markdown fences.",
  ].filter(Boolean).join("\n");

  const resp = await fetch(`${GOAL_HOST_VESSEL_ENDPOINT}/v2/impulses/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pointer: { type: "llm.completion" },
      body: {
        system: systemPrompt,
        user: scenarioContent,
        response_format: { type: "json_object" },
      },
    }),
  });
  if (!resp.ok) throw new Error(`llm_completion_dispatch HTTP ${resp.status}`);
  const raw = (await resp.json()) as { body?: { content?: string; text?: string } };
  const text = raw?.body?.content ?? raw?.body?.text ?? "";
  const parsed: unknown = JSON.parse(typeof text === "string" && text.length > 0 ? text : "{}");
  if (!isVesselFields(parsed)) throw new Error("llm_completion_dispatch: missing required fields in response");
  if (params.prBodyTrailer && !parsed.pr_body.includes(params.prBodyTrailer)) {
    parsed.pr_body = `${parsed.pr_body}\n\n${params.prBodyTrailer}`;
  }
  return parsed;
}

async function runHttpFetch(
  params: HttpFetchTaskParams,
  results: TaskResultMap
): Promise<unknown> {
  const fields = results[params.bodyFromTaskId];
  if (!isVesselFields(fields)) throw new Error("http_fetch: body source must contain vessel fields");

  const targetBranch = params.bodyTransform.git.target_branch_template.replace(
    "{{vessel_name}}",
    fields.vessel_name
  );

  const body = {
    goal: params.bodyTransform.goal,
    vessel_name: fields.vessel_name,
    port: fields.port,
    advertised_shapes_literal: fields.advertised_shapes_literal,
    description: fields.description,
    commit_message: fields.commit_message,
    pr_title: fields.pr_title,
    pr_body: fields.pr_body,
    git: {
      cwd: params.bodyTransform.git.cwd,
      owner: params.bodyTransform.git.owner,
      repo: params.bodyTransform.git.repo,
      base_branch: params.bodyTransform.git.base_branch,
      target_branch: targetBranch,
    },
  };

  const resp = await fetch(params.url, {
    method: params.method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`http_fetch POST ${params.url} HTTP ${resp.status}`);
  return resp.json();
}

async function executeCompose(def: ComposeDefinition): Promise<{ shape: string; body: unknown }> {
  const results: TaskResultMap = {};

  for (const task of def.tasks) {
    switch (task.type) {
      case "fs_list":
        results[task.id] = await runFsList(task.params as FsListTaskParams);
        break;
      case "json_path_extract":
        results[task.id] = await runJsonPathExtract(task.params as JsonPathExtractTaskParams, results);
        break;
      case "fs_read":
        results[task.id] = await runFsRead(task.params as FsReadTaskParams, results);
        break;
      case "llm_completion_dispatch":
        results[task.id] = await runLlmCompletionDispatch(task.params as LlmCompletionDispatchTaskParams, results);
        break;
      case "http_fetch":
        results[task.id] = await runHttpFetch(task.params as HttpFetchTaskParams, results);
        break;
      default: {
        const _exhaustive: never = task.type;
        throw new Error(`Unknown task type: ${_exhaustive}`);
      }
    }
  }

  const lastTask = def.tasks[def.tasks.length - 1];
  const lastResult = lastTask !== undefined ? results[lastTask.id] : undefined;

  return {
    shape: def.outputShape,
    body: {
      composeId: def.id,
      tags: def.tags,
      result: lastResult,
      taskResults: results,
    },
  };
}

export async function resolveVesselScaffoldDispatchResult(
  _impulseBody: Record<string, unknown>
): Promise<ResolverResult> {
  const output = await executeCompose(vesselAuthoringScenarioConsumer);
  return {
    shape: output.shape,
    body: output.body,
  };
}