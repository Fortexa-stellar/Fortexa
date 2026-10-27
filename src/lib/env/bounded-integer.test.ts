import { describe, expect, it } from "vitest";
import { parseBoundedInteger } from "@/lib/env/bounded-integer";

describe("parseBoundedInteger", () => {
  it("returns the fallback when the value is undefined", () => {
    expect(parseBoundedInteger(undefined, { fallback: 5 })).toBe(5);
  });

  it("returns the fallback when the value is an empty string", () => {
    expect(parseBoundedInteger("", { fallback: 5 })).toBe(5);
  });

  it("parses a valid integer string", () => {
    expect(parseBoundedInteger("7", { fallback: 5 })).toBe(7);
  });

  it("floors a fractional value", () => {
    expect(parseBoundedInteger("7.9", { fallback: 5 })).toBe(7);
  });

  it("returns the fallback for NaN input", () => {
    expect(parseBoundedInteger("not-a-number", { fallback: 5 })).toBe(5);
  });

  it("returns the fallback for zero when min defaults to 1", () => {
    expect(parseBoundedInteger("0", { fallback: 5 })).toBe(5);
  });

  it("accepts zero when min is explicitly 0", () => {
    expect(parseBoundedInteger("0", { fallback: 5, min: 0 })).toBe(0);
  });

  it("returns the fallback for a negative value", () => {
    expect(parseBoundedInteger("-3", { fallback: 5 })).toBe(5);
  });

  it("returns the fallback for an extreme value above max", () => {
    expect(parseBoundedInteger("999999999", { fallback: 5, max: 1000 })).toBe(5);
  });

  it("returns the fallback for Infinity", () => {
    expect(parseBoundedInteger("Infinity", { fallback: 5 })).toBe(5);
  });

  it("accepts a value exactly at the max bound", () => {
    expect(parseBoundedInteger("1000", { fallback: 5, max: 1000 })).toBe(1000);
  });

  it("accepts a value exactly at the min bound", () => {
    expect(parseBoundedInteger("2", { fallback: 5, min: 2 })).toBe(2);
  });
});
