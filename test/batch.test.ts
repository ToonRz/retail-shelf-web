import { describe, expect, it } from "vitest";
import {
  type BatchItemResult,
  type BatchRow,
  batchItemsToCsvRows,
  escapeCsvField,
  formatCountsSummary,
  formatTop1,
  generateCsv,
} from "../src/batch";
import type { Box } from "../src/agent-contract";

describe("Batch CSV & Detection Logic", () => {
  describe("escapeCsvField", () => {
    it("leaves normal strings unchanged", () => {
      expect(escapeCsvField("shelf.jpg")).toBe("shelf.jpg");
      expect(escapeCsvField("product123")).toBe("product123");
    });

    it("encloses strings containing commas in double quotes", () => {
      expect(escapeCsvField("shelf, front.jpg")).toBe('"shelf, front.jpg"');
      expect(escapeCsvField("lays, nori seaweed")).toBe('"lays, nori seaweed"');
    });

    it("escapes strings containing double quotes by doubling them", () => {
      expect(escapeCsvField('shelf "front".jpg')).toBe('"shelf ""front"".jpg"');
      expect(escapeCsvField('"quoted"')).toBe('"""quoted"""');
    });

    it("handles strings containing both commas and double quotes", () => {
      expect(escapeCsvField('shelf, "camera 1".jpg')).toBe('"shelf, ""camera 1"".jpg"');
    });

    it("encloses strings containing newlines in quotes", () => {
      expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
      expect(escapeCsvField("line1\r\nline2")).toBe('"line1\r\nline2"');
    });

    it("converts numbers and handles null/undefined", () => {
      expect(escapeCsvField(42)).toBe("42");
      expect(escapeCsvField(0.95)).toBe("0.95");
      expect(escapeCsvField(null)).toBe("");
      expect(escapeCsvField(undefined)).toBe("");
    });
  });

  describe("generateCsv", () => {
    it("generates CSV with required columns: file, product, count, max_conf", () => {
      const rows: BatchRow[] = [
        { file: "img1.jpg", product: "lays nori", count: 3, max_conf: 0.95 },
        { file: "img1.jpg", product: "pepsi", count: 2, max_conf: 0.88 },
      ];

      const csv = generateCsv(rows);
      const lines = csv.split("\r\n");

      expect(lines[0]).toBe("file,product,count,max_conf");
      expect(lines[1]).toBe("img1.jpg,lays nori,3,0.95");
      expect(lines[2]).toBe("img1.jpg,pepsi,2,0.88");
    });

    it("correctly escapes problematic filenames in the CSV output", () => {
      const rows: BatchRow[] = [
        { file: 'store, "shelf 1".jpg', product: 'snack, "spicy"', count: 5, max_conf: 0.92 },
      ];

      const csv = generateCsv(rows);
      const lines = csv.split("\r\n");

      expect(lines[1]).toBe('"store, ""shelf 1"".jpg","snack, ""spicy""",5,0.92');
    });

    it("produces only the header row when input rows list is empty", () => {
      expect(generateCsv([])).toBe("file,product,count,max_conf");
    });
  });

  describe("batchItemsToCsvRows", () => {
    it("converts detected items into row records per product", () => {
      const items: BatchItemResult[] = [
        {
          fileName: "shelf1.jpg",
          counts: [
            { cls: "lays-rock-salt", classId: 1, count: 4, maxConf: 0.941 },
            { cls: "pocky-chocolate", classId: 2, count: 2, maxConf: 0.879 },
          ],
          top: { cls: "lays-rock-salt", classId: 1, conf: 0.941, xyxy: [0, 0, 10, 10] },
        },
      ];

      const rows = batchItemsToCsvRows(items);
      expect(rows).toEqual([
        { file: "shelf1.jpg", product: "lays rock salt", count: 4, max_conf: 0.94 },
        { file: "shelf1.jpg", product: "pocky chocolate", count: 2, max_conf: 0.88 },
      ]);
    });

    it("records (none) with count 0 for images where no products were found", () => {
      const items: BatchItemResult[] = [
        {
          fileName: "empty_shelf.jpg",
          counts: [],
          top: null,
        },
      ];

      const rows = batchItemsToCsvRows(items);
      expect(rows).toEqual([
        { file: "empty_shelf.jpg", product: "(none)", count: 0, max_conf: 0 },
      ]);
    });

    it("records error status if detection failed for a file", () => {
      const items: BatchItemResult[] = [
        {
          fileName: "corrupt.jpg",
          counts: [],
          top: null,
          error: "decode error",
        },
      ];

      const rows = batchItemsToCsvRows(items);
      expect(rows).toEqual([
        { file: "corrupt.jpg", product: "(error: decode error)", count: 0, max_conf: 0 },
      ]);
    });
  });

  describe("table formatters", () => {
    it("formats counts summary readable string", () => {
      expect(
        formatCountsSummary([
          { cls: "lays", classId: 1, count: 3, maxConf: 0.9 },
          { cls: "pepsi", classId: 2, count: 1, maxConf: 0.8 },
        ])
      ).toBe("lays: 3, pepsi: 1");
      expect(formatCountsSummary([])).toBe("ไม่พบสินค้า");
    });

    it("formats top-1 product display", () => {
      const box: Box = { cls: "lays-classic", classId: 0, conf: 0.963, xyxy: [0, 0, 1, 1] };
      expect(formatTop1(box)).toBe("lays classic (96.3%)");
      expect(formatTop1(null)).toBe("–");
    });
  });
});

