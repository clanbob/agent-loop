// A deterministic stand-in at the CLI process boundary. No model account is used.
const fs = require("node:fs");

exports.run = function run(provider, trace, args) {
  const input = fs.readFileSync(0, "utf8");
  const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
  if (provider === "antigravity" && args[0] === "models") {
    console.log("gemini-example-low\tGemini Example (Low)\ngemini-example-high\tGemini Example (High)\ngemini-flash\tGemini Flash");
    return;
  }
  if (provider === "codex" && args.join(" ") === "debug models") {
    console.log(JSON.stringify({ models: [
      { slug: "codex-new", display_name: "Codex New", supported_reasoning_levels: [{ effort: "high" }] },
      { slug: "codex-small", display_name: "Codex Small" }, { slug: "internal", visibility: "hide" },
    ] }));
    return;
  }
  if (provider === "claude" && value("--input-format") === "stream-json") {
    const init = JSON.parse(input);
    if (init.type !== "control_request" || init.request.subtype !== "initialize") throw Error("Expected metadata only");
    console.log(JSON.stringify({ type: "control_response", response: {
      subtype: "success", request_id: init.request_id, response: { models: [
        { value: "opus", displayName: "Opus", resolvedModel: "claude-opus-example", supportedEffortLevels: ["high", "max"] },
        { value: "another-model", displayName: "Another model", supportsEffort: false },
      ] },
    } }));
    return;
  }
  let schema;
  if (provider === "codex") {
    if (args[0] !== "exec" || !value("-o")) throw Error("Expected codex exec with an output file");
    schema = JSON.parse(fs.readFileSync(value("--output-schema"), "utf8"));
  } else if (provider === "antigravity") {
    if (args.some((arg) => arg === "--print" || arg.startsWith("--print=")) || !input.trim()) {
      throw Error("Expected the Antigravity prompt on stdin only");
    }
    if (!value("--mode") || value("--output-format") !== "json") throw Error("Expected agy JSON output");
    schema = JSON.parse(fs.readFileSync(value("--json-schema"), "utf8"));
  } else {
    if (!args.includes("-p")) throw Error("Expected claude print mode");
    schema = value("--output-format") === "stream-json" ? null : JSON.parse(value("--json-schema"));
  }

  const fields = schema?.required ?? [];
  let step, answer;
  if (fields.includes("mode")) {
    step = "route";
    answer = input.includes("implement a review dashboard")
      ? { mode: "build", reason: "The request calls for a dashboard." }
      : { mode: "review", reason: "The request asks for an inspection." };
  } else if (fields.includes("decisions")) {
    step = "triage";
    answer = { decisions: [
      { id: "F1", verdict: "fix", reason: "Wrong total" },
      { id: "F2", verdict: "skip", reason: "Naming preference" },
    ], instructions: "Correct the inventory total." };
  } else if (fields.includes("instructions")) {
    step = "plan";
    answer = { instructions: "Add the requested inventory dashboard to the existing interface." };
  } else if (fields.includes("findings")) {
    step = "review";
    const issues = ["Incorrect inventory total", "Rename inventory entry"];
    const findings = input.includes("Findings you reported in the previous round") ? [] : issues.map((issue, i) => ({
      id: "F" + (i + 1), severity: "medium", file: "inventory", line: i + 1, issue, suggestion: "", repeat_of: null,
    }));
    answer = { summary: "Inspected inventory", findings };
    const zone = "ReplicatedStorage/Zone.luau";
    if (fs.existsSync(zone)) answer = { summary: fs.readFileSync(zone, "utf8"), findings: [] };
  } else {
    step = "build";
    answer = { summary: "Updated the inventory total" };
  }
  fs.appendFileSync(trace, JSON.stringify({ provider, step, cwd: process.cwd(), model: value("-m") ?? value("--model"), args, input }) + "\n");

  if (provider === "codex") fs.writeFileSync(value("-o"), JSON.stringify(answer));
  else if (!schema) console.log(JSON.stringify({ type: "result", result: answer.summary, session_id: value("--session-id") }));
  else if (provider === "claude") console.log(JSON.stringify({ type: "result", structured_output: answer }));
  else console.log(JSON.stringify({ response: JSON.stringify(answer) }));
};
