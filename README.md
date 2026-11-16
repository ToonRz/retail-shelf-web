# retail-shelf-web

เว็บตรวจจับสินค้าบนชั้นวาง **รัน model ใน browser** ไม่มี server (host บน GitHub Pages ฟรี): <https://toonrz.github.io/retail-shelf-web/>
ใช้ agent จาก [retail-shelf-agent](https://github.com/ToonRz/retail-shelf-agent) โดย pin เวอร์ชันไว้ใน `agent.version` และ `agent-shelf.version`
(แบบเดียวกับ zcrX pin zcrAgentX)

- Spec: [retail-shelf-detection/docs/agent-connection/SPEC.md](https://github.com/ToonRz/retail-shelf-detection/blob/main/docs/agent-connection/SPEC.md)
- รายงานผล (รวมผลทดสอบของเว็บ): [retail-shelf-detection README ข้อ 8](https://github.com/ToonRz/retail-shelf-detection#ข้อ-8--ต้นแบบ-prototype)

## หน้าเว็บ

| หน้า | ทำอะไร | agent |
|---|---|---|
| ตรวจจับ (หน้าแรก) | อัปรูป / ลากวาง / รูปตัวอย่าง / ถ่ายจากกล้อง → กรอบแยกสีตามสินค้า, ตารางนับต่อชนิด, สินค้าที่มั่นใจที่สุด, เวลาต่อรูป · slider ความมั่นใจ (เริ่ม 0.25) · เลือก backend WebGPU / WASM | `agent.version` · รันทั้งสอง model: ชื่อสินค้า 110 คลาส + กล่อง `product` สำหรับของที่ไม่รู้จัก |
| เฝ้าชั้นวาง (`#watch`) | เปิดกล้อง / วิดีโอ / รูปนิ่ง → หาช่องอัตโนมัติ (หรือลากเอง) → เฝ้าทุก 1 วินาที → เตือนช่องที่ว่างนานเกินที่ตั้ง (รายการ + เสียง + notification ของ browser) | `agent-shelf.version` · ตอนเฝ้าส่ง `shelfOnly: true` (shelf model อย่างเดียว) · ตอนหาช่องรันทั้งสอง model เพื่อเอาชื่อสินค้า |
| เกี่ยวกับ (`#about`) | ตัวเลขจากรายงาน, ที่มาของ dataset / model, ปุ่ม *วัดความเร็วเครื่องนี้* (20 รูปต่อ backend) | `agent.version` |

ทุกหน้าใช้ได้บนมือถือและรองรับ dark mode · ถ้าโหลดไม่ได้จะขึ้นสาเหตุเป็นภาษาไทย (`src/ui/logic.ts` `ERROR_TH`)

### หน้าเฝ้าชั้นวางทำงานอย่างไร

โค้ดหน้าอยู่ที่ `src/watch.ts` ส่วนตรรกะล้วนอยู่ที่ `src/ui/watch-logic.ts` (มี test ใน `test/watch.test.ts`)

1. **หาช่องอัตโนมัติ** (เลือกหรือลากรูป / วิดีโอมาวางแล้วหาให้ทันที หรือกดปุ่ม): รันทั้งสอง model กับภาพเต็มหนึ่งครั้งเพื่อหาสินค้าแต่ละชิ้น
   (กล่องที่ซ้อนกันเกิน 60% ของกล่องเล็กเป็นชิ้นเดียว ใช้กรอบของ shelf model ก่อน: `toFoundItems`) → crop ทีละชิ้น (ขยาย 15%, ไม่ได้ชื่อที่ conf ≥ 0.5 ลอง 40%)
   ให้ model 110 คลาสตั้งชื่อ (`cropRect`, `cropLabel`) ไม่ได้ชื่อ = "สินค้าอื่น" สูงสุด 60 ชิ้น → แบ่งแถว แล้วรวมสินค้าชื่อเดียวกันที่ติดกันเป็นช่อง ช่องละไม่เกิน 6 ชิ้น (`autoSlots`)
   → ตัดช่องที่ตอนนั้นก็ดูว่างแล้วทิ้ง กันเตือนผิด · วิดีโอหยุดรอที่ภาพที่ใช้หาช่องจนกด *เริ่มเฝ้า* · ระหว่างหาช่องคืน main thread ให้ browser ทุกครั้งที่รัน model (มีแถบ progress)
2. แก้ชื่อ / ลบ / ลากเพิ่มช่องได้ · ช่องจำไว้ใน `localStorage` ของเครื่อง
3. **เฝ้า:** ทุก 1 วินาที crop แต่ละช่องส่งให้ shelf model · "มีของ" = มีกล่องใหญ่ ≥ 4% ของช่องและจุดกลางอยู่ใน 80% ด้านใน (`slotHasProduct`)
   · ว่างติดกันนานเท่าที่ตั้ง (เริ่ม 15 วินาที) → เตือน "ของหมด" · ของกลับมา 3 วินาที → ยกเลิก (`stepTrack`)
   · ภาพในช่องเปลี่ยนมาก (คนบัง / มือหยิบ) → วินาทีนั้นไม่นับ · วิดีโอจบแล้วบอกช่องที่ว่างแต่ยังไม่ถึงเวลาที่ตั้ง
4. **กรอบตามภาพเมื่อกล้องซูม / เลื่อน** (เปิดไว้เป็นค่าเริ่มต้น): จำช่องในพิกัดของภาพอ้างอิง แล้วทุกรอบรัน shelf model ทั้งภาพ จับคู่กล่องกับภาพอ้างอิง (`fitViews`)
   และปรับละเอียดด้วยการเทียบภาพขาวดำ 128×96 (`refineView`, `viewScore`) · ช่องที่อยู่ในภาพไม่ถึง 40% = "นอกภาพ" หยุดนับเวลา · เทียบไม่ชัด = ใช้ตำแหน่งล่าสุด
   · รองรับซูม ×0.33–×3 และเลื่อน ไม่รองรับการหมุนหรือเปลี่ยนมุมกล้อง

## agent.version

| ค่า | ผล |
|---|---|
| `mock` | ใช้ `src/mockAgent.ts` (กล่องปลอม) สำหรับ dev โดยไม่ต้องดาวน์โหลด release |
| `vX.Y.Z` | โหลด `<base>agent/vX.Y.Z/shelf-agent.js` ซึ่ง `make fetch-agent-release` วางไว้ใน `public/agent/vX.Y.Z/` ตอน build — ไม่ commit |

ตอนนี้ทั้ง `agent.version` และ `agent-shelf.version` = **`v0.3.2`** (model 110 คลาส + shelf model ใน release เดียว, ~56 MB)
`agent-shelf.version` ใช้กติกาเดียวกัน · `make fetch-agent-release` ดึงทั้งสองเวอร์ชัน · `make bump-agent` ขยับแค่ `agent.version`
หน้าเฝ้าชั้นวางต้องใช้ release ที่มีทั้งสอง model (`v0.3.x`) และ `v0.3.2` ขึ้นไปสำหรับ `shelfOnly` · ถ้าเป็น `v0.2.x` ทุกช่องจะได้ชื่อ `product`

ค่าอื่นทำให้ build ล้ม (`vite.config.ts: readAgentVersion`) · เว็บคุยกับ agent ผ่าน `src/agent.ts` ที่เดียว ตาม interface ใน `src/agent-contract.ts`
(สำเนาของ `retail-shelf-agent/src/types.ts` แก้ที่หนึ่งต้องแก้อีกที่)

## Dev

```bash
npm ci
npm run dev       # http://localhost:5173/retail-shelf-web/
npm test
npm run build     # dist/ สำหรับ GitHub Pages
```

## Agent release (SPEC §7)

```bash
make fetch-agent-release                  # ดึง release ตาม agent.version + agent-shelf.version ลง public/agent/<v>/ แล้วตรวจ SHA256SUMS / manifest / contract
make bump-agent                           # ไป patch ล่าสุดของ minor เดิม → npm test + npm run build (พังเมื่อไรคืน pin เดิม, ไม่ commit ให้)
make bump-agent AGENT_VERSION=v0.4.0 ALLOW_MINOR=1   # ข้าม minor ต้องใส่ ALLOW_MINOR=1 · ถอยเวอร์ชันไม่ได้
make agent-lag                            # บอกว่ามี patch ใหม่กว่า pin ไหม (CI ขึ้นเป็น warning)
```

ใช้ release ในเครื่องแทน GitHub ได้: `AGENT_RELEASES_DIR=../retail-shelf-agent/release make fetch-agent-release`
(โฟลเดอร์ที่มี `vX.Y.Z/` จาก `npm run package` ของ agent) · โค้ดอยู่ที่ `scripts/agent-release.mjs` · test: `test/agent-release.test.ts`

CI (`.github/workflows/ci.yml`): `npm ci` → `make fetch-agent-release` → `npm test` → `npm run build` → `make agent-lag` (warning)
Deploy: push `main` → `.github/workflows/pages.yml` (`npm ci` → `make fetch-agent-release` → `npm test` → `npm run build` → Pages)

## สถานะ

| ส่วน | สถานะ |
|---|---|
| pin `agent.version` / `agent-shelf.version` + ตรวจรูปแบบ, `loadAgent()` (mock / release จริง), mock agent | ✅ มี test |
| หน้าตรวจจับ + หน้าเกี่ยวกับ | ✅ ทดสอบใน Chromium (WebGPU และ WASM) กับ release จริง · วัดความเร็วแล้วบน Chrome + RTX 4060 และ Safari บน iPhone 17 Pro (รายงาน ข้อ 8.1.3) |
| `make bump-agent`, `make fetch-agent-release`, deploy Pages, warning เมื่อ pin ตามหลัง patch ล่าสุด | ✅ test ด้วย release ปลอม |
| GitHub Pages (Source: GitHub Actions) | ✅ https://toonrz.github.io/retail-shelf-web/ |
| หน้าเฝ้าชั้นวาง: เฝ้า + เตือน | ✅ ตรรกะมี test · Chromium (WebGPU) กับวิดีโอทดสอบ 6 ช่อง (conf 0.25, เตือนเมื่อว่าง 15 วินาที): เตือนครบ 6 ช่อง ไม่มีเตือนก่อนของหมดจริง ช้ากว่าเวลาที่ตั้ง 2.5–21.5 วินาที · `v0.3.2` + `shelfOnly` ได้กล่องตรงกับ `v0.2.1` ทุกรูป ~340 ms ต่อช่อง (WASM) |
| หน้าเฝ้าชั้นวาง: หาช่องอัตโนมัติ | ✅ Chromium (WASM) กับชั้นสังเคราะห์ 4×3, 3×3, 3×2 จากรูปตัวอย่างและภาพหน้าจอชั้นวาง: ได้ชื่อถูกทุกช่อง ใช้ 6–15 วินาที · วิดีโอ 6 ช่องที่เอาของออก 3 ช่อง: เตือนครบ 3 ช่อง อีก 3 ช่องไม่เตือน |
| หน้าเฝ้าชั้นวาง: กรอบตามภาพเมื่อซูม / เลื่อน | ✅ Chromium (WASM): ซูม ×1.3 ประมาณได้ ×1.302 เตือนครบ ไม่มีเตือนผิด · ชั้น 4×3 ซูม ×1.57 ได้ ×1.568 เตือนถูกช่อง · ช้าลงรอบละ 1 การรัน model กับภาพเต็ม |
| ยังไม่ได้ทดสอบ | ชั้นวางและกล้องจริงในร้าน, Firefox, Safari บน Mac, Chrome บน Android |
| ยังไม่มี | โหมดตรวจทุกเฟรมจากกล้องในหน้าตรวจจับ, ใช้ offline (service worker), ตรวจหลายรูปแล้วดาวน์โหลด CSV |

สินค้าที่ไม่อยู่ใน 110 คลาสได้ชื่อ "สินค้าอื่น" หรือชื่อใกล้เคียงตอนหาช่อง (แก้ชื่อในตารางได้) · การเฝ้าใช้ shelf model จึงไม่ขึ้นกับชื่อ
