import { describe, expect, it } from "vitest";
import { decodeMandala, mandalaValuePrefix } from "../src/pool/mandala";

const ID = Array(32).fill(0x11);
const P2PKH = [0x76, 0xa9, 0x14, ...Array(20).fill(0x22), 0x88, 0xac];

describe("Mandala prefix (Pool.runar.go tokenPrefix; 1sat-sdk Mandala.decode rules)", () => {
  it("pushes 1..16 as OP_1..OP_16, larger amounts minimally", () => {
    expect(mandalaValuePrefix(ID, 1n).slice(33)).toEqual([0x51, 0x6d]);
    expect(mandalaValuePrefix(ID, 16n).slice(33)).toEqual([0x60, 0x6d]);
    expect(mandalaValuePrefix(ID, 17n).slice(33)).toEqual([1, 0x11, 0x6d]);
    expect(mandalaValuePrefix(ID, 255n).slice(33)).toEqual([2, 0xff, 0x00, 0x6d]);
    expect(mandalaValuePrefix(ID, 256n).slice(33)).toEqual([2, 0x00, 0x01, 0x6d]);
  });

  it("round-trips through decode", () => {
    for (const amount of [1n, 16n, 17n, 255n, 1_000_000n, 0xffff_ffff_ffff_ffffn]) {
      const script = [...mandalaValuePrefix(ID, amount), ...P2PKH];
      const t = decodeMandala(script)!;
      expect(t.role).toBe("value");
      expect(t.amount).toBe(amount);
      expect(Array.from(t.idBytes!)).toEqual(ID);
      expect(script.slice(t.length)).toEqual(P2PKH);
    }
  });

  it("decodes deploys and authorities, and a payload", () => {
    expect(decodeMandala([0x00, 0x51, 0x6d, ...P2PKH])!.role).toBe("deploy");
    expect(decodeMandala([0x20, ...ID, 0x00, 0x6d, ...P2PKH])!.role).toBe("authority");
    const withPayload = decodeMandala([0x20, ...ID, 0x51, 0x6d, 0x02, 0xaa, 0xbb, 0x75, ...P2PKH])!;
    expect(Array.from(withPayload.payload!)).toEqual([0xaa, 0xbb]);
    expect(withPayload.length).toBe(33 + 1 + 1 + 4);
  });

  it("refuses non-minimal amounts, PUSHDATA ids and a 36-byte id with vout 0", () => {
    expect(decodeMandala([0x20, ...ID, 0x01, 0x05, 0x6d])).toBeNull(); // 5 must be OP_5
    expect(decodeMandala([0x20, ...ID, 0x02, 0x11, 0x00, 0x6d])).toBeNull(); // trailing zero
    expect(decodeMandala([0x4c, 0x20, ...ID, 0x51, 0x6d])).toBeNull();
    expect(decodeMandala([0x24, ...ID, 0, 0, 0, 0, 0x51, 0x6d])).toBeNull();
    expect(decodeMandala([0x20, ...ID, 0x51, 0x75])).toBeNull(); // no OP_2DROP
  });

  it("refuses a zero amount, an id that is not 32 bytes, and amounts past 2^64-1", () => {
    expect(() => mandalaValuePrefix(ID, 0n)).toThrow();
    expect(() => mandalaValuePrefix([0xaa], 1n)).toThrow();
    expect(() => mandalaValuePrefix(ID, 1n << 64n)).toThrow();
  });
});
