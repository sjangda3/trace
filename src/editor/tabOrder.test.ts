import { describe, expect, it } from "vitest";
import { reorderByPath } from "./tabOrder";

type DocumentStub = {
  path: string;
  content: string;
};

const createDocuments = (): DocumentStub[] => [
  { path: "src/first.ts", content: "first" },
  { path: "src/second.ts", content: "second" },
  { path: "src/third.ts", content: "third" },
  { path: "src/fourth.ts", content: "fourth" },
];

describe("reorderByPath", () => {
  it("supports forward and backward drag reordering", () => {
    const documents = createDocuments();

    const movedForward = reorderByPath(documents, "src/first.ts", "src/third.ts");
    expect(movedForward.map(({ path }) => path)).toEqual([
      "src/second.ts",
      "src/third.ts",
      "src/first.ts",
      "src/fourth.ts",
    ]);

    const movedBackward = reorderByPath(movedForward, "src/fourth.ts", "src/second.ts");
    expect(movedBackward.map(({ path }) => path)).toEqual([
      "src/fourth.ts",
      "src/second.ts",
      "src/third.ts",
      "src/first.ts",
    ]);
  });

  it("is a stable no-op for unknown, same-path, or duplicate-path input", () => {
    const documents = createDocuments();

    expect(reorderByPath(documents, "src/missing.ts", "src/first.ts")).toBe(documents);
    expect(reorderByPath(documents, "src/first.ts", "src/missing.ts")).toBe(documents);
    expect(reorderByPath(documents, "src/first.ts", "src/first.ts")).toBe(documents);

    const duplicate = [...documents, { path: "src/second.ts", content: "duplicate" }];
    expect(reorderByPath(duplicate, "src/first.ts", "src/third.ts")).toBe(duplicate);
  });

  it("preserves item identity, content, and unaffected relative order", () => {
    const documents = createDocuments();
    const reordered = reorderByPath(documents, "src/third.ts", "src/first.ts");

    expect(reordered).not.toBe(documents);
    expect(reordered).toEqual([documents[2], documents[0], documents[1], documents[3]]);
    expect(reordered[0]).toBe(documents[2]);
    expect(reordered[1]).toBe(documents[0]);
    expect(reordered[2]).toBe(documents[1]);
    expect(reordered[3]).toBe(documents[3]);
    expect(documents.map(({ content }) => content)).toEqual(["first", "second", "third", "fourth"]);
  });
});
