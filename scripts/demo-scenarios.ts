import { evaluateScenarioCatalog, validateScenarioPack } from "../src/lib/scenarios/evaluate";
import { demoScenarios } from "../src/lib/scenarios/seed";

(async () => {
  console.log("Fortexa Scenario Demo Runner\n");

  const evaluations = await evaluateScenarioCatalog();
  let driftCount = 0;

  for (const evaluation of evaluations) {
    console.log(`Scenario: ${evaluation.scenario.title}`);
    console.log(`Expected: ${evaluation.expected} | Actual: ${evaluation.actual}`);
    console.log(`Risk Score: ${evaluation.result.riskScore}`);
    console.log(`Explanation: ${evaluation.result.explanation}`);
    if (evaluation.result.triggeredPolicies.length > 0) {
      console.log(
        `Policies: ${evaluation.result.triggeredPolicies.map((item) => item.code).join(", ")}`
      );
    }
    if (evaluation.result.riskFindings.length > 0) {
      console.log(
        `Findings: ${evaluation.result.riskFindings.map((item) => item.code).join(", ")}`
      );
    }
    if (!evaluation.matches) {
      driftCount += 1;
      console.log(`DRIFT: ${evaluation.scenario.id} no longer matches its seed.`);
    }
    console.log("---");
  }

  const issues = validateScenarioPack({
    scenarios: demoScenarios,
    evaluations,
  });
  for (const issue of issues) {
    console.error(`DRIFT: ${issue.message}`);
  }

  if (driftCount > 0 || issues.length > 0) {
    console.error(
      `\n${Math.max(driftCount, issues.length)} seeded scenario(s) drifted from engine output. Failing.`
    );
    process.exitCode = 1;
    return;
  }

  console.log("\nAll seeded scenarios match engine output.");
})();
