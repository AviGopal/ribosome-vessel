// The vessel module, loaded for tests. Not a test file itself.
//
// src/index.ts binds its HTTP port, opens the activity-api WebSocket and starts discovery
// registration at import. Inside the substrate container the live vessel holds its port, so a
// STATIC import fails the importing file with EADDRINUSE: an unnamed load failure the pull-sync
// gate refuses. Every test that needs index.ts imports it from here, so the environment is set
// once, before the one dynamic import, and no two files can disagree about it (whichever file
// loads the module first would fix the values for all of them).
//
// PORT=0 takes a free port. The endpoints point at a closed local port, so the WebSocket and the
// registration fail fast and nothing reaches a live vessel. The empty key makes the extraction
// dispatch skip itself, so no test can send one.
process.env["PORT"] = "0";
process.env["ACTIVITY_API_ENDPOINT"] = "http://127.0.0.1:9";
process.env["DISCOVERY_VESSEL_ENDPOINT"] = "http://127.0.0.1:9";
process.env["GOAL_HOST_VESSEL_ENDPOINT"] = "http://127.0.0.1:9";
process.env["RIBOSOME_VESSEL_ID"] = "ribosome-vessel-test";
process.env["RIBOSOME_VESSEL_API_KEY"] = "";

export const vessel = await import("../src/index");
