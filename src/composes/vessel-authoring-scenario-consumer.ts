import type { ComposeDefinition } from "../types/compose";

export const vesselAuthoringScenarioConsumer: ComposeDefinition = {
  id: "vessel-authoring-scenario-consumer",
  tags: ["boredom_target_template", "lift.autonomous.loop", "vessel.addition"],
  outputShape: "vesselScaffoldDispatchResult",
  tasks: [
    {
      id: "list-scenario-files",
      type: "fs_list",
      params: {
        path: "/workspace/validation/failure-modes/vessel-scenarios",
        glob: "*.json",
        shuffle: true,
      },
    },
    {
      id: "extract-first-entry",
      type: "json_path_extract",
      params: {
        sourceTaskId: "list-scenario-files",
        jsonPath: "$[0]",
      },
    },
    {
      id: "read-scenario-file",
      type: "fs_read",
      params: {
        pathFromTaskId: "extract-first-entry",
      },
    },
    {
      id: "generate-vessel-fields",
      type: "llm_completion_dispatch",
      params: {
        sourceTaskId: "read-scenario-file",
        requiredFields: [
          "vessel_name",
          "port",
          "advertised_shapes_literal",
          "description",
          "commit_message",
          "pr_title",
          "pr_body",
        ],
        prBodyTrailer: "Substrate-Authored-By: substrate-llm",
      },
    },
    {
      id: "dispatch-scaffold-goal",
      type: "http_fetch",
      params: {
        method: "POST",
        url: "http://127.0.0.1:8210/run-goal",
        bodyFromTaskId: "generate-vessel-fields",
        bodyTransform: {
          goal: "development-vessel:scaffold-and-publish-vessel",
          git: {
            cwd: "/workspace",
            owner: "metabob",
            repo: "metabob-devbob",
            base_branch: "dev",
            target_branch_template: "substrate-authored/{{vessel_name}}-scaffold",
          },
        },
      },
    },
  ],
};
