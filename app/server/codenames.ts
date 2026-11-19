import { shuffle } from "./matching.ts";

const aliases = [
  "Sir Wraps-a-Lot",
  "Professor Jinglepants",
  "Detective Eggnog",
  "The North Pole Intern",
  "Mittens McGee",
  "The Cookie Accountant",
  "Captain Ribbon Spaghetti",
  "Deputy Sleigh Bell",
  "The Wrapping Paper Bandit",
  "Marshmallow Supreme",
  "The Mistletoe Bouncer",
  "Agent Peppermint",
  "The Gingerbread Getaway Driver",
  "Duchess of Leftovers",
  "The Gravy Goblin",
  "Snowman in Witness Protection",
  "The Reindeer Union Rep",
  "The Festive Raccoon",
  "The Soggy Fruitcake",
  "Elf on Probation",
  "The Sleigh Mechanic",
  "The Tinsel Menace",
  "The Jolly Tax Auditor",
  "Lord of the Onion Rings",
];

export function drawCodenames(count: number): string[] {
  const names = shuffle([...aliases]);
  return Array.from({ length: count }, (_, index) => {
    const alias = names[index % names.length];
    const round = Math.floor(index / names.length);
    return round ? `${alias} #${round + 1}` : alias;
  });
}
