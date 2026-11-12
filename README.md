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

`agent-shelf.version` ใช้กติกาเดียวกัน สำหรับหน้า "เฝ้าชั้นวาง" (`#watch`): agent สาย `v0.2.x` ที่มี model 1 คลาส `product` (SKU-110K)
`make fetch-agent-release` ดึงทั้งสองเวอร์ชัน · `make bump-agent` ขยับแค่ `agent.version`
`agent.version` ใช้สาย `v0.3.x` (model 110 คลาส + shelf model ใน release เดียว) · หน้าเฝ้าชั้นวางไม่ต้องใช้ `v0.3.x` เพราะนับแค่ว่ามีกล่องหรือไม่

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
| หน้าเฝ้าชั้นวาง `#watch` (วาดช่อง / กล้องหรือไฟล์วิดีโอ / เตือนของหมดหลังว่างนาน N วินาที / หยุดนับตอนมีคนบัง / เสียง + notification) | ✅ (2026-11-12) `agent-shelf.version` = `v0.2.1` (shelf model v2, 30 epoch) · ตรรกะมี test (`test/watch.test.ts`) · ทดสอบใน Chromium (WebGPU) กับวิดีโอทดสอบที่ conf 0.25: เตือนครบ 6 ช่อง ไม่มีเตือนก่อนของหมดจริง ช้ากว่าเวลาที่ตั้ง 2.5–21.5 วินาที |
| ใช้ Offline ได้ + Service Worker cache model / shell / assets + ขึ้นป้าย "ใช้ offline ได้แล้ว" | ✅ ตรรกะเลือก/ลบ cache มี test (`test/sw.test.ts`) · ทดสอบใน Chromium (Network Offline) หลัง reload ยังตรวจรูปได้ปกติ |
| หน้าตรวจหลายรูป `#batch` (เลือกหลายรูปพร้อมกัน / แถบความคืบหน้า / สรุปตาราง / ดาวน์โหลด CSV) | ✅ มี test สร้าง CSV และ escape ชื่อไฟล์ (`test/batch.test.ts`) · ทดสอบรัน batch และดาวน์โหลด CSV ใน browser แล้ว |
