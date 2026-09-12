// Only ignore labels that do not change the identity or preparation of a food.
const LABELS = new Set(["bio", "organic", "biologisch", "fresh", "frisch"])

function normalize(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/ß/g, "ss").replace(/[^\p{L}\p{N}]+/gu, " ").trim()
    .split(/\s+/).filter(token => !LABELS.has(token)).join("")
}

// Explicit equivalents avoid fuzzy substring matches across different food types.
const EQUIVALENTS = [
  ["Basmati-Reis", "Basmatireis", "Basmati rice"],
  ["Kokosöl", "Kokosoel", "coconut oil"],
  ["Kokosmilch", "coconut milk"],
  ["Tomatenmark", "tomato paste"],
  ["Aubergine", "Auberginen", "eggplant", "eggplants"],
  ["Ingwer", "ginger"],
  ["Zwiebel", "Zwiebeln", "onion", "onions"],
  ["Salz", "salt"],
  ["Reis", "rice"],
  ["Milch", "milk"],
  ["Wasser", "water"],
  ["Tomate", "Tomaten", "tomato", "tomatoes"],
  ["Kartoffel", "Kartoffeln", "potato", "potatoes"],
  ["Knoblauch", "garlic"],
  ["Karotte", "Karotten", "Möhre", "Möhren", "carrot", "carrots"],
  ["Ei", "Eier", "egg", "eggs"],
]
const aliases = new Map(EQUIVALENTS.flatMap(group =>
  group.map(name => [normalize(name), normalize(group[0])] as const),
))

export function isSuitableOffMatch(foodName: string, productName: string | undefined): boolean {
  if (!productName) return false
  const food = normalize(foodName)
  const product = normalize(productName)
  if (!food || !product) return false
  return (aliases.get(food) ?? food) === (aliases.get(product) ?? product)
}
