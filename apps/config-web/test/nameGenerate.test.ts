import { describe, expect, it } from "vitest";
import { NAME_GENERATE_GENDERS, generateName, nameGeneratePath } from "../src/nameGenerate.js";

describe("name/generate", () => {
  it("matches only the two-segment contract path", () => {
    expect(nameGeneratePath("/api/name/generate/default/male")).toEqual({ generator: "default", gender: "male" });
    expect(nameGeneratePath("/api/name/generate/elf/female")).toEqual({ generator: "elf", gender: "female" });
    expect(nameGeneratePath("/api/name/generate/default")).toBeUndefined();
    expect(nameGeneratePath("/api/name/generate/default/male/extra")).toBeUndefined();
    expect(nameGeneratePath("/api/name/generate/or%20c/neutral")).toEqual({ generator: "or c", gender: "neutral" });
  });

  it("accepts exactly the three contract genders", () => {
    expect([...NAME_GENERATE_GENDERS].sort()).toEqual(["female", "male", "neutral"]);
  });

  it("produces a two-part name and honours the gender pool deterministically", () => {
    const low = () => 0;
    expect(generateName("default", "male", low)).toBe("Aldric Ironhammer");
    expect(generateName("default", "female", low)).toBe("Adela Ironhammer");
    expect(generateName("default", "neutral", low)).toBe("Aldric Ironhammer");
    expect(generateName("orc", "male", low)).toBe("Gorbad Skullsmasha");
  });

  it("falls back to the default style for unknown generators (open upstream id space)", () => {
    const low = () => 0;
    expect(generateName("nurgle-rotters", "male", low)).toBe(generateName("default", "male", low));
  });

  it("keeps capitalised surname halves space-joined (Von Carstein) and compounds the rest", () => {
    const low = () => 0;
    expect(generateName("vampire", "male", low)).toBe("Abhorash Von Carstein");
    expect(generateName("elf", "female", low)).toBe("Aeliana Silverleaf");
  });

  it("always returns a non-empty name for every style and gender", () => {
    for (const generator of ["default", "elf", "orc", "dwarf", "skaven", "amazon", "norse", "vampire", "unknown"]) {
      for (const gender of ["male", "female", "neutral"]) {
        const name = generateName(generator, gender);
        expect(name.trim().length).toBeGreaterThan(2);
        expect(name).toContain(" ");
      }
    }
  });
});
