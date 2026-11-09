import test from "node:test";
import assert from "node:assert/strict";
import { joinPdfItems, resumeSections } from "./import.ts";

const resume = `Jordan Rivera
Senior Software Engineer · Austin, TX · jordan@example.com · (555) 010-2233
PROFESSIONAL SUMMARY
Backend engineer with 8 years building payment systems.
WORK EXPERIENCE
Senior Software Engineer, Acme Payments   2021 – Present

\t•\tLed a team of 5 to rebuild the ledger service in Go.
Technical Skills & Tools:
Go, Rust, Kafka
Projects
ledgerlite — open-source ledger library
Education
B.S. Computer Science, 2017
Certifications
AWS Solutions Architect
Awards
Hackathon winner
Salary Expectations
$190k base`;

test("resume headings split into the right profile fields", () => {
  const s = resumeSections(resume);
  assert.equal(s.name, "Jordan Rivera");
  assert.equal(s.summary, "Backend engineer with 8 years building payment systems.");
  assert.match(s.experience, /^Senior Software Engineer, Acme Payments/);
  assert.match(s.experience, /\n• Led a team of 5/);
  assert.equal(s.skills, "Go, Rust, Kafka");
  assert.equal(s.projects, "ledgerlite — open-source ledger library");
  assert.equal(s.education, "B.S. Computer Science, 2017\nAWS Solutions Architect");
});

test("contact details, unknown sections and salary stay out of the fields", () => {
  const all = Object.values(resumeSections(resume)).join("\n");
  assert.ok(!/@example\.com|555|Hackathon|190k|Salary/i.test(all));
});

test("inline headings and resumes without a header", () => {
  const s = resumeSections("Skills: TypeScript, React\nExperience\nBuilt things");
  assert.equal(s.skills, "TypeScript, React");
  assert.equal(s.experience, "Built things");
  assert.equal(s.name, "");
});

test("PDF runs split at ligatures rejoin without spurious spaces", () => {
  const run = (str, x, width, y = 700, hasEOL = false) => ({
    str, width, height: 10, hasEOL, transform: [10, 0, 0, 10, x, y],
  });
  assert.equal(
    joinPdfItems([
      run("AWS Certi", 0, 45), run("fi", 45, 8), run("ed", 53, 10),
      run("2021", 120, 20), run("Next line", 0, 40, 685),
    ]),
    "AWS Certified 2021\nNext line",
  );
});
