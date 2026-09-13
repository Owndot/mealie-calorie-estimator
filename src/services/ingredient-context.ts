import type { MealieIngredient, MealieRecipe } from "../types.js"

export type FoodState = "unspecified" | "dry" | "cooked" | "canned" | "drained" | "raw" | "frozen" | "fresh" | "ambiguous"
export interface IngredientContext {
  generic?: boolean
  brand?: string | null
  category?: string
  interpretationConfidence?: number
  interpretationSource?: "deterministic" | "LLM" | "unresolved"
  originalName: string
  canonicalName: string
  state: FoodState
  query: string
  reason: string
  confidence: "high" | "medium" | "low"
  fatPercentage?: number
  descriptorNotes?: string[]
}
export const NUTRITION_VERSION = "nutrition-v10-energy-consistency"

export function normalizeFoodText(text: unknown): string {
  if (typeof text !== "string") return ""
  return text.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/ß/g, "ss").replace(/[^\p{L}\p{N}%]+/gu, " ").trim().replace(/\s+/g, " ")
}
export interface IngredientDescriptors {
  normalized: string
  baseName: string
  states: FoodState[]
  notes: string[]
}
const groups: Record<string, string[]> = {
  "pinto beans": ["Wachtelbohnen", "Wachtelbohne", "Pintobohnen", "Pintobohne", "pinto bean"],
  "kidney beans": ["Kidneybohnen", "Kidneybohne", "kidney bean", "rote Bohnen"],
  beans: ["Bohnen", "Bohne", "bean"],
  chickpeas: ["Kichererbsen", "Kichererbse", "chickpea"],
  "basmati rice": ["Basmati-Reis", "Basmatireis"], rice: ["Reis"],
  "coconut milk": ["Kokosmilch"], "coconut drink": ["Kokosdrink", "coconut milk drink"],
  "coconut oil": ["Kokosöl", "Kokosoel"], "olive oil": ["Olivenöl", "Olivenoel"],
  "sunflower oil": ["Sonnenblumenöl", "Sonnenblumenoel"], butter: ["Butter", "unsalted butter"],
  salt: ["Salz", "Speisesalz", "Tafelsalz", "table salt"],
  onion: ["Zwiebel", "Zwiebeln", "onions", "weiße Zwiebel", "weiße Zwiebeln", "white onion", "white onions"],
  "red onion": ["rote Zwiebel", "rote Zwiebeln", "roter Zwiebel", "red onions"],
  garlic: ["Knoblauch", "Knoblauchzehe", "Knoblauchzehen", "garlic clove", "garlic cloves"],
  tomato: ["Tomate", "Tomaten", "tomatoes"], "tomato paste": ["Tomatenmark"],
  ginger: ["Ingwer"], eggplant: ["Aubergine", "Auberginen", "eggplants"],
  potato: ["Kartoffel", "Kartoffeln", "potatoes"], carrot: ["Karotte", "Karotten", "Möhre", "Möhren", "carrots"],
  flour: ["Mehl", "Weizenmehl", "wheat flour"], cumin: ["Kreuzkümmel", "cumin seed"],
  "curry powder": ["Currypulver"], pepper: ["Pfeffer", "schwarzer Pfeffer", "black pepper"],
  thyme: ["Thymian"], parsley: ["Petersilie"], coriander: ["Koriander"],
  "coriander leaves": ["Korianderblätter", "cilantro", "coriander leaf"],
  "coriander seeds": ["Koriandersamen", "Koriandersaat", "coriander seed"],
  cream: ["Sahne", "Schlagsahne"], "cooking cream": ["Kochsahne"], parmesan: ["Parmesan", "Parmigiano Reggiano"],
  milk: ["Milch"], water: ["Wasser"], egg: ["Ei", "Eier", "eggs"],
}
const aliases = new Map(Object.entries(groups).flatMap(([key, names]) =>
  [key, ...names].map(name => [normalizeFoodText(name), key] as const),
))
const descriptorRules: Array<{ state?: FoodState; note?: string; pattern: RegExp }> = [
  { state: "drained", note: "drained", pattern: /\b(abgetropft\w*|abgegossen\w*|abtropfgewicht|drained)\b/g },
  { state: "canned", pattern: /\b(a\s+d\s+(?:(?:der|dem)\s+)?dose[n]?|aus\s+(?:der|dem)\s+dose[n]?|aus\s+dose[n]?|dose[n]?|konserve[n]?|canned|tinned)\b/g },
  { state: "dry", note: "sun-dried", pattern: /\b(sun\s*[- ]?dried)\b/g },
  { state: "dry", pattern: /\b(trocken\w*|getrocknet\w*|dried|dry|uncooked)\b/g },
  { state: "cooked", pattern: /\b(gekocht\w*|vorgekocht\w*|cooked|boiled)\b/g },
  { state: "raw", pattern: /\b(roh\w*|raw)\b/g },
  { state: "frozen", pattern: /\b(tiefgekuhlt\w*|gefroren\w*|frozen|tk)\b/g },
  { state: "fresh", pattern: /\b(frisch\w*|fresh)\b/g },
  { note: "chopped", pattern: /\b(gehackt\w*|chopped)\b/g },
  { note: "diced", pattern: /\b(gewurfelt\w*|diced)\b/g },
  { note: "peeled", pattern: /\b(geschalt\w*|peeled)\b/g },
  { note: "in oil", pattern: /\b(in\s+(?:dem\s+)?(?:ol|oil|oel))\b/g },
  { note: "in oil", pattern: /\b(in\s+(?:ol|oil|oel)\w*\s+eingelegt)\b/g },
  { note: "in brine", pattern: /\b(in\s+(?:lake|brine))\b/g },
  { note: "pickled", pattern: /\b(eingelegt\w*|pickled|preserved)\b/g },
  { state: "cooked", note: "roasted", pattern: /\b(gerostet\w*|roasted)\b/g },
]
const prep = /\b(fein|grob|finely|roughly|bio|organic|biologisch\w*|gewurfelt\w*|gehackt\w*|geschnitten\w*|gerieben\w*|gemahlen\w*|geschalt\w*|diced|chopped|sliced|grated|ground|peeled)\b/g
const staples = new Set(["pinto beans", "kidney beans", "rice", "basmati rice"])
const freshFoods = new Set(["onion", "red onion", "garlic", "ginger", "eggplant", "tomato", "potato", "carrot"])

export function normalizeIngredientDescriptors(text: unknown): IngredientDescriptors {
  const normalized = normalizeFoodText(text)
  const stateText = normalized.replace(/\b(frisch|freshly)\s+(gerieben\w*|gemahlen\w*|gehackt\w*|geschnitten\w*|grated|ground|chopped|sliced)\b/g, "$2")
  let baseName = stateText
  const states: FoodState[] = []
  const notes: string[] = []
  for (const rule of descriptorRules) {
    if (rule.pattern.test(stateText)) {
      if (rule.state && !states.includes(rule.state)) states.push(rule.state)
      if (rule.note && !notes.includes(rule.note)) notes.push(rule.note)
      baseName = baseName.replace(new RegExp(rule.pattern.source, "g"), " ")
    }
    rule.pattern.lastIndex = 0
  }
  return { normalized, baseName: baseName.trim().replace(/\s+/g, " "), states, notes }
}

export function interpretIngredient(
  ingredient: Pick<MealieIngredient, "food"> & Partial<MealieIngredient>,
  instructions: MealieRecipe["recipeInstructions"] = [],
  defaults = true,
): IngredientContext {
  const originalName = typeof ingredient.food?.name === "string" ? ingredient.food.name : ""
  const nameDescriptor = normalizeIngredientDescriptors(originalName)
  const name = nameDescriptor.baseName
  const rawDetail = [originalName, ingredient.note, ingredient.originalText, ingredient.original_text, ingredient.display].filter(value => typeof value === "string").join(" ")
  const detailDescriptors = normalizeIngredientDescriptors(rawDetail)
  const detail = detailDescriptors.normalized
  const fatMatch = rawDetail.match(/\b(\d+(?:[.,]\d+)?)\s*%(?:\s*(?:fett|fat))?/i)
  const fatPercentage = fatMatch ? Number(fatMatch[1].replace(",", ".")) : undefined
  let identity = name.replace(prep, " ")
  identity = identity.replace(/\b(vollfett\w*|full fat)\b/g, " ")
  identity = identity.replace(/\b(aus der|aus dem|in der|from the|in a)\b/g, " ").trim().replace(/\s+/g, " ")
  let canonicalName = aliases.get(identity) ?? identity
  // Nutrition-changing qualifiers in notes must not disappear when the food name is generic.
  const qualifiers = detail.match(/\b(light|fettarm\w*|fettreduziert\w*|low fat|reduced fat|low sodium|natriumarm\w*|salted|gesalzen\w*|sweetened|gesusst\w*|krautersalz|kalium\w*)\b/g)
  if (qualifiers?.length && !qualifiers.some(q => identity.includes(q))) canonicalName += ` ${[...new Set(qualifiers)].join(" ")}`
  const states = detailDescriptors.states.slice()
  if (/\b(dose[n]?|konserve[n]?|can[s]?|tin[s]?)\b/.test(normalizeFoodText(ingredient.unit?.name))) states.push("canned")
  const primaryStates = states.filter(candidate => candidate !== "drained")
  let state: FoodState = primaryStates[0] ?? states[0] ?? "unspecified"
  if (states.includes("drained") && states.includes("canned") && !states.includes("dry")) state = "drained"
  let reason = states.length ? "explicit ingredient state" : "no explicit state"
  let confidence: IngredientContext["confidence"] = states.length ? "high" : "low"
  if ((states.includes("dry") && states.some(s => ["cooked", "canned"].includes(s))) || /\b(nicht|not)\s+(gekocht|cooked|getrocknet|dried)\b/.test(detail)) {
    state = "ambiguous"; reason = "conflicting preparation states"; confidence = "low"
  }
  if (canonicalName === "coriander") {
    if (state === "fresh" || /\b(blatter|leaves|leaf|cilantro)\b/.test(detail)) canonicalName = "coriander leaves"
    else if (/\b(samen|saat|seeds?)\b/.test(detail)) canonicalName = "coriander seeds"
  }
  if (defaults && state === "unspecified") {
    const relatedSteps = (instructions ?? []).filter(step => {
      if (typeof step !== "string" && ingredient.referenceId && step.ingredientReferences?.some(ref => ref.referenceId === ingredient.referenceId)) return true
      const text = normalizeFoodText(typeof step === "string" ? step : step.text)
      if (canonicalName.includes("beans") || canonicalName === "beans") return /\b(bohnen|beans)\b/.test(text)
      return text.includes(name)
    }).map(step => normalizeFoodText(typeof step === "string" ? step : step.text)).join(" ")
    if ((canonicalName.includes("beans") || canonicalName === "beans") && /\b(einweichen|soak\w*)\b/.test(relatedSteps)) {
      state = "dry"; reason = "ingredient-linked soaking instruction"; confidence = "medium"
    } else if (staples.has(canonicalName)) {
      state = "dry"; reason = "dry staple input-weight default"; confidence = "medium"
    } else if (freshFoods.has(canonicalName)) {
      state = "raw"; reason = "unprepared vegetable default"; confidence = "medium"
    } else if (["parsley", "coriander leaves"].includes(canonicalName)) {
      state = "fresh"; reason = "leaf herb default"; confidence = "medium"
    }
  }
  if (staples.has(canonicalName) && state === "raw") { state = "dry"; reason = "raw mature staple means dry" }
  const query = [canonicalName, state === "unspecified" ? "" : state, ...detailDescriptors.notes].filter(Boolean).join(" ")
  return { originalName, canonicalName, state, query, reason, confidence, fatPercentage, descriptorNotes: detailDescriptors.notes }
}

export function contextForName(name: string): IngredientContext {
  return interpretIngredient({ food: { id: "", name, pluralName: null, aliases: [] } })
}
export function nutrientCacheKey(source: "off" | "llm", context: IngredientContext): string {
  return `${NUTRITION_VERSION}:${source}:${context.canonicalName}:${context.state}:${(context.descriptorNotes ?? []).join(",")}:${context.fatPercentage ?? ""}:${context.brand ?? ""}:${context.generic ?? "unknown"}`
}

export function isKnownFoodIdentity(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(groups, name)
}
