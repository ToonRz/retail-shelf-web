# retail-shelf-web

เว็บตรวจจับสินค้าบนชั้นวาง **รัน model ใน browser** ไม่มี server (host บน GitHub Pages ฟรี)
ใช้ agent จาก [retail-shelf-agent](https://github.com/ToonRz/retail-shelf-agent) โดย pin เวอร์ชันไว้ใน `agent.version`
(แบบเดียวกับ zcrX pin zcrAgentX)

- Spec: [retail-shelf-detection/docs/agent-connection/SPEC.md](https://github.com/ToonRz/retail-shelf-detection/blob/main/docs/agent-connection/SPEC.md)
- งานที่เหลือและเจ้าของงาน: [TASKS.md](https://github.com/ToonRz/retail-shelf-detection/blob/main/docs/agent-connection/TASKS.md)

## agent.version

| ค่า | ผล |
|---|---|
| `mock` | ใช้ `src/mockAgent.ts` (กล่องปลอม) — ใช้จนกว่าจะมี release แรก |
| `vX.Y.Z` | โหลด `<base>agent/vX.Y.Z/shelf-agent.js` ซึ่ง `make fetch-agent-release` วางไว้ใน `public/agent/vX.Y.Z/` ตอน build — ไม่ commit |

`agent-shelf.version` ใช้กติกาเดียวกัน สำหรับหน้า "เฝ้าชั้นวาง" (`#watch`) · ตอนนี้ = `v0.3.2` เท่ากับ `agent.version` (เดิม `v0.2.1` ที่มีแค่ model 1 คลาส `product`)
`make fetch-agent-release` ดึงทั้งสองเวอร์ชัน · `make bump-agent` ขยับแค่ `agent.version`
`agent.version` ใช้สาย `v0.3.x` (model 110 คลาส + shelf model ใน release เดียว) · หน้าเฝ้าชั้นวางก็ใช้ `v0.3.x` ด้วย: ตอนเฝ้านับแค่ว่ามีกล่องหรือไม่ จึงส่ง `shelfOnly: true` (agent `v0.3.2`+) ให้รันแค่ shelf model เร็วเท่า `v0.2.1` · ปุ่ม "หาช่องอัตโนมัติ" รันทั้งสอง model (ไม่ส่ง `shelfOnly`) เพื่อเอาชื่อสินค้ามาแบ่งช่อง จึงต้องใช้ release ที่มีทั้งสอง model (`v0.3.x`) ถ้าเป็น `v0.2.x` ทุกช่องจะได้ชื่อ `product`

ค่าอื่นทำให้ build ล้ม (`vite.config.ts: readAgentVersion`) · เว็บคุยกับ agent ผ่าน `src/agent.ts` ที่เดียว ตาม interface ใน `src/agent-contract.ts`

## Dev

```bash
npm ci
npm run dev       # http://localhost:5173/retail-shelf-web/
npm test
npm run build     # dist/ สำหรับ GitHub Pages
```

## Agent release (SPEC §7)

```bash
make fetch-agent-release                  # ดึง release ตาม agent.version ลง public/agent/<v>/ แล้วตรวจ SHA256SUMS / manifest / contract
make bump-agent                           # ไป patch ล่าสุดของ minor เดิม → npm test + npm run build (พังเมื่อไรคืน pin เดิม, ไม่ commit ให้)
make bump-agent AGENT_VERSION=v0.2.0 ALLOW_MINOR=1   # ข้าม minor ต้องใส่ ALLOW_MINOR=1 · ถอยเวอร์ชันไม่ได้
make agent-lag                            # บอกว่ามี patch ใหม่กว่า pin ไหม (CI ขึ้นเป็น warning)
```

ใช้ release ในเครื่องแทน GitHub ได้: `AGENT_RELEASES_DIR=../retail-shelf-agent/release make fetch-agent-release`
(โฟลเดอร์ที่มี `vX.Y.Z/` จาก `npm run package` ของ agent) · โค้ดอยู่ที่ `scripts/agent-release.mjs` · test: `test/agent-release.test.ts`

Deploy: push `main` → `.github/workflows/pages.yml` (`npm ci` → `make fetch-agent-release` → `npm test` → `npm run build` → Pages)

## สถานะ

| ส่วน | สถานะ |
|---|---|
| pin `agent.version` + ตรวจรูปแบบ, `loadAgent()` (mock / release จริง), mock agent | ✅ มี test · ทดสอบใน browser แล้วว่าโหลด release จริงได้ถึงขั้น createSession |
| หน้า UI (อัปรูป / ลากวาง / รูปตัวอย่าง / กล้อง / เลือก backend / กล่องแยกสี / นับสินค้า / conf slider / progress / ข้อความ error ภาษาไทย / About / มือถือ + dark mode / วัดความเร็ว) | ✅ B1–B4, A5 · ทดสอบใน Chromium กับ release จริงแล้ว |
| `make bump-agent`, `make fetch-agent-release`, deploy Pages, warning เมื่อ pin ตามหลัง patch ล่าสุด | ✅ C2, C3 · test ด้วย release ปลอม |
| GitHub Pages (Source: GitHub Actions) | ✅ https://toonrz.github.io/retail-shelf-web/ |
| bump ไป `v0.1.0` | ✅ T4 (2026-11-10): `agent.version` = `v0.1.0` (model จริง 110 คลาส) |
| bump ไป `v0.3.1` (รวม 2 model) | ✅ (2026-11-12): `agent.version` = `v0.3.1` · หน้าตรวจจับได้ชื่อสินค้า 110 คลาสเหมือนเดิม + กล่อง `product` (classId 110) สำหรับของที่ model 110 คลาสไม่รู้จัก · รัน 2 model ต่อรูป จึงช้ากว่า v0.1.0 ราว 2 เท่า · ทดสอบใน Chromium (WASM) กับรูปตัวอย่างแล้ว · หน้าเฝ้าชั้นวางยังอยู่ที่ `v0.2.1` |
| หน้าเฝ้าชั้นวาง `#watch` (วาดช่อง / กล้องหรือไฟล์วิดีโอ / เตือนของหมดหลังว่างนาน N วินาที / หยุดนับตอนมีคนบัง / เสียง + notification) | ✅ (2026-11-12) `agent-shelf.version` = `v0.2.1` (shelf model v2, 30 epoch) · (2026-11-13) ย้ายไป `v0.3.1` เหมือนหน้าตรวจจับ: ใน Chromium (WASM) ตัดสินมีของ/ว่างตรงกับ `v0.2.1` ทุกภาพ (รูปตัวอย่าง 4 รูป = มีของ, ชั้นว่างสังเคราะห์ 2 ภาพ = ว่าง) แต่ช้าขึ้นจาก ~374 เป็น ~764 ms ต่อช่อง เตือนช้าลงตามจำนวนช่อง · ยังไม่ได้รันกับวิดีโอทดสอบซ้ำ · (2026-11-13) `v0.3.2` + `shelfOnly`: กลับมา ~340 ms ต่อช่อง กล่องตรงกับ `v0.2.1` ทุกรูป · ลองทั้งหน้าใน Chromium (WASM) ด้วยกล้องจำลอง 2 ช่อง: ~671 ms ต่อรอบ ช่องที่มีของ = มีของ, ช่องว่าง = เตือนของหมด · ตรรกะมี test (`test/watch.test.ts`) · ทดสอบใน Chromium (WebGPU) กับวิดีโอทดสอบที่ conf 0.25: เตือนครบ 6 ช่อง ไม่มีเตือนก่อนของหมดจริง ช้ากว่าเวลาที่ตั้ง 2.5–21.5 วินาที |
| ปุ่ม "หาช่องอัตโนมัติ" ในหน้าเฝ้าชั้นวาง | ✅ (2026-11-13) กดตอนชั้นเต็ม: (1) รันทั้งสอง model กับภาพเต็มหนึ่งครั้ง (2) กล่อง `product` ที่ model 110 คลาสไม่รู้จัก crop ทีละกล่อง (ขยาย 15%) แล้วรันซ้ำเพื่อหาชื่อ (ต้อง conf ≥ 0.5 ไม่งั้นเป็น "สินค้าอื่น", สูงสุด 60 กล่อง) เพราะ model 110 คลาสรู้จักสินค้าเฉพาะตอนเต็มภาพ (3) แบ่งแถวตามการซ้อนกันแนวตั้ง แล้วรวมสินค้าชื่อเดียวกันที่วางติดกัน (ห่างไม่เกินครึ่งความกว้างกล่อง) เป็นช่องเดียว ช่องละไม่เกิน 6 ชิ้น (แบ่งเท่า ๆ กัน ให้ชิ้นริมสุดยังอยู่ใน 80% ด้านในของช่อง) กรอบขยาย 4% (4) ตรวจทุกช่องด้วยกติกาเดียวกับตอนเฝ้า (`shelfOnly` + `slotHasProduct`) ช่องที่ตอนนี้ก็ดูว่างแล้วตัดทิ้ง กันเตือนผิด · แทนที่ช่องเดิม (ถามก่อน) แล้วแก้ชื่อ / ลบ / ลากเพิ่มได้ตามเดิม · ตรรกะอยู่ใน `src/ui/watch-logic.ts` (`autoSlots`, `toFoundItems`, `cropLabel`, `cropRect`) มี test · ทดสอบใน Chromium (WASM) กับชั้นสังเคราะห์จากรูปตัวอย่าง 10 ชิ้น 2 แถว: ใช้ ~11 วินาที ได้ 5 ช่อง (lays ×3, pocky, pocky 2, hanami ×2, copp ×3 · pocky แยก 2 ช่องเพราะในรูปตัวอย่างกล่อง pocky เล็กจึงห่างกันเกินเกณฑ์) ตัด 1 ช่องที่เป็นกล่องจากฉากหลังของรูป · เฝ้าต่อด้วยวิดีโอที่เอา copp ออกวินาทีที่ 8 (เตือนเมื่อว่าง 15 วินาที): เตือน copp วินาทีที่ 27 ช่องอื่นไม่เตือน · ยังไม่ได้ลองกับชั้นวางจริงและวิดีโอทดสอบ 6 ช่อง |
