# Gift Picker Pro (GitHub Pages)

הפרויקט הועתק מ:
- https://github.com/Banditor/gift-picker-pro

בוצעו התאמות כדי שיעבוד על GitHub Pages:
- ניתוב `HashRouter` במקום `BrowserRouter`
- הגדרת `base: "./"` ב-Vite
- פריסת Pages אוטומטית דרך GitHub Actions (`.github/workflows/deploy.yml`)
- סיסמת ניהול מעודכנת: `E123123`

## הרצה מקומית

```bash
npm install
npm run dev
```

## בנייה

```bash
npm run build
npm run preview
```

## פריסה ל-GitHub Pages

1. דחוף את הקוד לענף `main`.
2. ב-GitHub: `Settings -> Pages`.
3. בחר מקור: `GitHub Actions`.
4. אחרי ה-Workflow, האתר יעלה ל-URL של Pages.

## הגדרות Supabase

הפרויקט משתמש ב:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

אם צריך, עדכן את הערכים בקובץ `.env`.
## תשתית "חפש את המטמון" (מהיר)

הרצה ראשונית:

```bash
npm install
npx playwright install chromium
npm run treasure:init
```

מצב תחרות מהיר:

```bash
npm run treasure:watch
```

לסריקה מלאה (איטית יותר, עם צילומי מסך):

```bash
node scripts/treasure-hunt/runner.mjs scan --full --open-on-hit
```

תיעוד מלא:
- `docs/TREASURE_HUNT.md`

## גיבוי דרך GitHub (כשלא ליד המחשב)

נוסף Workflow אוטומטי:
- `.github/workflows/treasure-monitor.yml`

מה הוא עושה:
- רץ כל 5 דקות אוטומטית.
- מעלה ארטיפקטים עם תוצאות הסריקה.
- יוצר Issue אם נמצא HIT.
- מסמן את הריצה כ-FAILED על HIT כדי לבלוט בהתראות.

הפעלה ידנית:
1. GitHub -> Actions -> Treasure Monitor
2. Run workflow
