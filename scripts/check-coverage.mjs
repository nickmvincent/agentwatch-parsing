import { readFileSync } from "fs";

const coveragePath = process.argv[2] ?? "coverage/lcov.info";
const minLines = Number(process.env.COVERAGE_LINES ?? "95");
const minFunctions = Number(process.env.COVERAGE_FUNCTIONS ?? "0");
const minBranches = Number(process.env.COVERAGE_BRANCHES ?? "0");

const lcov = readFileSync(coveragePath, "utf8");
const records = lcov.split("end_of_record\n").filter(Boolean);

const totals = {
  lines: { hit: 0, found: 0 },
  functions: { hit: 0, found: 0 },
  branches: { hit: 0, found: 0 }
};

const isSrc = (file) =>
  file.startsWith("src/") || file.includes("/src/") || file.includes("\\src\\");

for (const record of records) {
  const lines = record.trim().split("\n");
  let include = false;

  for (const line of lines) {
    if (line.startsWith("SF:")) {
      const file = line.slice(3).trim();
      include = isSrc(file);
    }

    if (!include) continue;

    if (line.startsWith("DA:")) {
      const [, hit] = line.slice(3).split(",");
      totals.lines.found += 1;
      if (Number(hit) > 0) totals.lines.hit += 1;
    }

    if (line.startsWith("FNDA:")) {
      const [hit] = line.slice(5).split(",");
      totals.functions.found += 1;
      if (Number(hit) > 0) totals.functions.hit += 1;
    }

    if (line.startsWith("BRDA:")) {
      const parts = line.slice(5).split(",");
      totals.branches.found += 1;
      if (parts[3] && parts[3] !== "-" && Number(parts[3]) > 0) {
        totals.branches.hit += 1;
      }
    }
  }
}

const pct = (hit, found) => (found === 0 ? 100 : (hit / found) * 100);
const results = {
  lines: pct(totals.lines.hit, totals.lines.found),
  functions: pct(totals.functions.hit, totals.functions.found),
  branches: pct(totals.branches.hit, totals.branches.found)
};

const failures = [];
if (minLines > 0 && results.lines < minLines) {
  failures.push(`lines ${results.lines.toFixed(2)}% < ${minLines}%`);
}
if (totals.functions.found > 0 && minFunctions > 0 && results.functions < minFunctions) {
  failures.push(`functions ${results.functions.toFixed(2)}% < ${minFunctions}%`);
}
if (totals.branches.found > 0 && minBranches > 0 && results.branches < minBranches) {
  failures.push(`branches ${results.branches.toFixed(2)}% < ${minBranches}%`);
}

console.log(
  `Coverage (src): lines ${results.lines.toFixed(2)}% ` +
    `functions ${results.functions.toFixed(2)}% ` +
    `branches ${results.branches.toFixed(2)}%`
);

if (failures.length > 0) {
  console.error(`Coverage thresholds not met: ${failures.join(", ")}`);
  process.exit(1);
}
