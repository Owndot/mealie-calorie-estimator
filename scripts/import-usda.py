# Regenerate the checked-in reference profiles from the official USDA SR Legacy CSV archive.
import zipfile,csv,io,json,sys
from pathlib import Path
z=zipfile.ZipFile(sys.argv[1])
def rows(name): return csv.DictReader(io.TextIOWrapper(z.open(next(n for n in z.namelist() if n.endswith('/'+name)))))
foods={r['fdc_id']:r['description'] for r in rows('food.csv')}
selected={'pinto beans:dry':'175199','pinto beans:cooked':'175200','pinto beans:canned':'175201','pinto beans:drained':'174286','kidney beans:dry':'173744','kidney beans:cooked':'175194','kidney beans:canned':'175195','kidney beans:drained':'174285','rice:dry':'169756','rice:cooked':'169757','butter:unspecified':'173430','olive oil:unspecified':'171413','sunflower oil:unspecified':'171025','coconut oil:unspecified':'171412','coconut milk:unspecified':'170173','onion:raw':'170000','garlic:raw':'169230','flour:unspecified':'169761','cumin:unspecified':'170923','curry powder:unspecified':'170924','thyme:dry':'170938','thyme:fresh':'173470','parsley:fresh':'170416','coriander leaves:fresh':'169997','coriander seeds:unspecified':'170922','pepper:unspecified':'170931','ginger:raw':'169231','eggplant:raw':'169228','tomato:raw':'170457','parmesan:unspecified':'170848'}
for id,d in foods.items():
 if d.startswith('Tomato products, canned, paste, without salt added'): selected['tomato paste:unspecified']=id
keys={'1008':'kcalPer100g','1003':'proteinPer100g','1004':'fatPer100g','1005':'carbsPer100g','1079':'fiberPer100g','2000':'sugarPer100g','1258':'saturatedFatPer100g','1257':'transFatPer100g','1093':'sodiumPer100g','1253':'cholesterolPer100g'}
profiles={id:{k:None for k in keys.values()} for id in selected.values()}
for r in rows('food_nutrient.csv'):
 if r['fdc_id'] in profiles and r['nutrient_id'] in keys: profiles[r['fdc_id']][keys[r['nutrient_id']]]=float(r['amount'])
portions={id:[] for id in profiles}
for r in rows('food_portion.csv'):
 if r['fdc_id'] in portions and ('tbsp' in r['modifier'] or 'tsp' in r['modifier'] or 'cup' in r['modifier'] or 'clove' in r['modifier'] or 'medium' in r['modifier']): portions[r['fdc_id']].append({'description':r['modifier'],'amount':float(r['amount']),'grams':float(r['gram_weight'])})
result={}
for key,id in selected.items():
 p=profiles[id].copy()
 # USDA carbohydrate by difference includes fiber; internal convention is available carbohydrate.
 if p['carbsPer100g'] is not None and p['fiberPer100g'] is not None: p['carbsPer100g']=round(max(0,p['carbsPer100g']-p['fiberPer100g']),3)
 p['unsaturatedFatPer100g']=round(max(0,p['fatPer100g']-(p['saturatedFatPer100g'] or 0)-(p['transFatPer100g'] or 0)),3) if p['fatPer100g'] is not None else None
 result[key]={'fdcId':id,'description':foods[id],'nutrients':p,'portions':portions[id]}
target = Path(__file__).resolve().parents[1] / 'src/nutrition-data/generic-foods.ts'
target.parent.mkdir(exist_ok=True)
target.write_text('// Generated from USDA SR Legacy (2018). See docs/nutrition.md for sources and units.\nexport default '+json.dumps(result,ensure_ascii=False,indent=2)+'\n')
