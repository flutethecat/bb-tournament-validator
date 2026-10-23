import { describe, expect, it } from "vitest";
import { bb2025 } from "@bb/validator/dataset";
import { inducementIdForName, inducementReducedFor, inducementWireGold } from "../src/dataset/inducements";

// The bloodbowlbase.ru BB2025 inducements page is the complete list (owner ruling 10-23).
describe("BB2025 inducement catalogue matches the rulebook page", () => {
  it("has exactly the page's inducements: no Igor, no Special Play Cards", () => {
    expect(Object.keys(bb2025.inducements).sort()).toEqual([
      "biased_referee", "bloodweiser_kegs", "bribes", "extra_team_training", "halfling_master_chef", "hireling_sports_wizard",
      "infamous_coaching_staff", "mercenaries", "mortuary_assistant", "part_time_assistant_coaches", "plague_doctor",
      "prayers_to_nuffle", "riotous_rookies", "star_players", "team_mascot", "temp_agency_cheerleaders", "wandering_apothecaries", "weather_mage",
    ]);
    expect(bb2025.inducements.igor).toBeUndefined();
    expect(bb2025.inducements.special_play_cards).toBeUndefined();
  });

  it("uses the page's names, keeping the former names as aliases (stored files still resolve)", () => {
    expect(bb2025.inducements.bloodweiser_kegs).toMatchObject({ name: "Blitzer's Best Kegs", aliases: ["Bloodweiser Kegs"], wireName: "bloodweiserBabes", cost: 50_000, max: 2 });
    expect(bb2025.inducements.wandering_apothecaries).toMatchObject({ name: "Wandering Apothecary", aliases: ["Wandering Apothecaries"], requiresApothecary: true });
    expect(bb2025.inducements.hireling_sports_wizard!.name).toBe("Wizard (Sports-Wizard)");
    expect(bb2025.inducements.mercenaries!.name).toBe("Mercenary Players");
    for (const name of ["Bloodweiser Kegs", "Blitzer's Best Kegs", "blitzers best kegs", "Hireling Sports-Wizard", "Mercenaries", "Wandering Apothecaries"])
      expect(inducementIdForName(bb2025, name)).toBeDefined();
    expect(inducementIdForName(bb2025, "Bloodweiser Kegs")).toBe("bloodweiser_kegs");
    expect(inducementIdForName(bb2025, "Igor")).toBeUndefined();
  });

  it("prices and caps match the page", () => {
    const row = (id: string) => [bb2025.inducements[id]!.cost, bb2025.inducements[id]!.max];
    expect(row("prayers_to_nuffle")).toEqual([10_000, 3]);
    expect(row("part_time_assistant_coaches")).toEqual([20_000, 5]);
    expect(row("temp_agency_cheerleaders")).toEqual([5_000, 5]);
    expect(row("team_mascot")).toEqual([25_000, 1]);
    expect(row("weather_mage")).toEqual([25_000, 1]);
    expect(row("extra_team_training")).toEqual([100_000, 8]);
    expect(row("wandering_apothecaries")).toEqual([100_000, 2]);
    expect(row("biased_referee")).toEqual([120_000, 1]);
    expect(bb2025.inducements.biased_referee).toMatchObject({ reducedCost: 80_000, reducedSpecialRule: "Bribery and Corruption" });
    expect(bb2025.inducements.bribes).toMatchObject({ cost: 100_000, max: 3, reducedCost: 50_000, reducedMax: 6, reducedSpecialRule: "Bribery and Corruption" });
    expect(bb2025.inducements.mercenaries).toMatchObject({ cost: 30_000, max: 3 });
  });

  it("restrictions follow the page", () => {
    expect(bb2025.inducements.mortuary_assistant!.requiresSpecialRule).toBe("Masters of Undeath");
    expect(bb2025.inducements.plague_doctor!.requiresSpecialRule).toBe("Favoured of Nurgle");
    expect(bb2025.inducements.riotous_rookies!.requiresSpecialRule).toBe("Low Cost Linemen");
  });

  it("the Halfling Master Chef discount is for Halfling teams (a Gnome team with the same league rule pays full price)", () => {
    const chef = bb2025.inducements.halfling_master_chef!;
    expect(chef).toMatchObject({ cost: 300_000, reducedCost: 100_000, reducedRoster: "Halfling" });
    expect(chef.reducedSpecialRule).toBeUndefined();
    const gnomeRules = bb2025.rosters.Gnome!.specialRules;
    expect(gnomeRules).toContain("Halfling Thimble Cup");
    expect(inducementWireGold(bb2025, "halfling_master_chef", bb2025.rosters.Halfling!.specialRules, "Halfling")).toBe(100_000);
    expect(inducementWireGold(bb2025, "halfling_master_chef", gnomeRules, "Gnome")).toBe(300_000);
    expect(inducementWireGold(bb2025, "halfling_master_chef", [], "halfling")).toBe(100_000);
    expect(inducementReducedFor(chef, [], undefined)).toBe(false);
    // rule-keyed discounts are unchanged
    expect(inducementWireGold(bb2025, "bribes", ["Bribery and Corruption"], "Black Orc")).toBe(50_000);
    expect(inducementWireGold(bb2025, "bribes", [], "Human")).toBe(100_000);
  });
});
