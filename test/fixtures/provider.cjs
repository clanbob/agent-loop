// A deterministic stand-in at the CLI process boundary. No model account is used.
const fs = require("node:fs");

exports.run = function run(provider, trace, args) {
  const input = fs.readFileSync(0, "utf8");
  const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
  let schema;
  if (provider === "codex") {
    if (args[0] !== "exec" || !value("-o")) throw Error("Expected codex exec with an output file");
    schema = JSON.parse(fs.readFileSync(value("--output-schema"), "utf8"));
  } else if (provider === "antigravity") {
    if (!args.includes("--print") || !value("--mode")) throw Error("Expected agy print mode");
    schema = JSON.parse(fs.readFileSync(value("--json-schema"), "utf8"));
  } else {
    if (!args.includes("-p")) throw Error("Expected claude print mode");
    schema = value("--output-format") === "stream-json" ? null : JSON.parse(value("--json-schema"));
  }

  const fields = schema?.required ?? [];
  let step, answer;
  if (fields.includes("mode")) {
    step = "plan";
    answer = { mode: "review", reason: "Inspect existing work", instructions: "Review the inventory." };
  } else if (fields.includes("decisions")) {
    step = "triage";
    answer = { decisions: [
      { id: "F1", verdict: "fix", reason: "Wrong total" },
      { id: "F2", verdict: "skip", reason: "Naming preference" },
    ], instructions: "Correct the inventory total." };
  } else if (fields.includes("findings")) {
    step = "review";
    const issues = ["Incorrect inventory total", "Rename inventory entry"];
    const findings = input.includes("Findings you reported in the previous round") ? [] : issues.map((issue, i) => ({
      id: "F" + (i + 1), severity: "medium", file: "inventory", line: i + 1, issue, suggestion: "", repeat_of: null,
    }));
    answer = { summary: "Inspected inventory", findings };
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
