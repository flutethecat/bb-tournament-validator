import { describe, expect, it } from "vitest";
import { buildForkJnlp, jnlpFilename } from "@bb/fork-jnlp";

describe("buildForkJnlp", () => {
  it("builds the fork-join arguments in order, defaulting the password", () => {
    const jnlp = buildForkJnlp({ coach: "Gondra87", teamId: "1264703", gameName: "TestGame1" });
    expect(jnlp).toContain("<argument>-player</argument><argument>-fork</argument>");
    expect(jnlp).toContain("<argument>-coach</argument><argument>Gondra87</argument>");
    expect(jnlp).toContain("<argument>-password</argument><argument>12345</argument>");
    expect(jnlp).toContain("<argument>-gameName</argument><argument>TestGame1</argument>");
    expect(jnlp).toContain("<argument>-teamId</argument><argument>1264703</argument>");
    expect(jnlp).toContain("FUMBBL40k fork - TestGame1 (Gondra87)");
  });

  it("uses an explicit password when given", () => {
    const jnlp = buildForkJnlp({ coach: "A", teamId: "1", gameName: "G", password: "hunter2" });
    expect(jnlp).toContain("<argument>-password</argument><argument>hunter2</argument>");
  });

  it("never embeds a fork host", () => {
    const jnlp = buildForkJnlp({ coach: "A", teamId: "1", gameName: "G" });
    expect(jnlp).not.toMatch(/https?:\/\//);
  });

  it("XML-escapes coach and game name", () => {
    const jnlp = buildForkJnlp({ coach: "A & <B>", teamId: "1", gameName: "G's \"Cup\"" });
    expect(jnlp).toContain("A &amp; &lt;B&gt;");
    expect(jnlp).toContain("G&apos;s &quot;Cup&quot;");
  });

  it("produces a filesystem-safe filename", () => {
    expect(jnlpFilename("Test Game 1", "Gondra87")).toBe("fork_Test_Game_1_Gondra87.jnlp");
  });

  it("strips path separators from the filename (the actual traversal vector)", () => {
    // A bare ".." with no adjacent separator can't traverse directories; "/" and "\" are
    // what matters, and those must never survive into the filename.
    const name = jnlpFilename("../../etc", "A/B\\C");
    expect(name).not.toContain("/");
    expect(name).not.toContain("\\");
    expect(name.endsWith(".jnlp")).toBe(true);
  });
});
