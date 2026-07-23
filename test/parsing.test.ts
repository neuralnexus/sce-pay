import assert from "node:assert/strict";
import test from "node:test";

import {
  extractConfirmation,
  extractDueDate,
  labeledMoney,
  safeAccountReference,
} from "../src/parsing.js";

const reviewText = `
SCE Guest Payment Review
Payment amount: $284.17
Convenience fee: $3.99
Total payment: $288.16
Card ending in 4242
Payment due 07/31/2026
`;

test("guest review values parse deterministically", () => {
  assert.equal(labeledMoney(reviewText, ["payment amount"]), 28_417);
  assert.equal(labeledMoney(reviewText, ["convenience fee"]), 399);
  assert.equal(labeledMoney(reviewText, ["total payment"]), 28_816);
  assert.equal(extractDueDate(reviewText), "2026-07-31");
});

test("confirmation parser accepts labeled receipt identifiers", () => {
  assert.equal(
    extractConfirmation("Thank you. Confirmation number: SCE-AB12-3400"),
    "SCE-AB12-3400",
  );
});

test("account references are irreversible", () => {
  const reference = safeAccountReference("123-456-7890-12");
  assert.match(reference, /^sce-[a-f0-9]{12}$/);
  assert.equal(reference.includes("123456"), false);
});
