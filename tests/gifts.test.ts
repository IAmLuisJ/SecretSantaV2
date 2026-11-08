import assert from "node:assert/strict";
import { test } from "node:test";
import { GiftError, inspectPhoto, productUrl } from "../app/server/gifts.ts";

test("product links accept a pasted HTTP URL or a bare domain", () => {
  assert.equal(productUrl("My gift https://example.com/gift"), "https://example.com/gift");
  assert.equal(productUrl("example.com/gift"), "https://example.com/gift");
  assert.equal(productUrl(""), "");
  for (const bad of ["javascript:alert(1)", "data:text/html,hi", "https://user:pass@example.com/"]) {
    assert.throws(() => productUrl(bad), GiftError);
  }
});

test("photos use the bytes and reject unsupported, mismatched, and oversized files", async () => {
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2xkAAAAASUVORK5CYII=", "base64"));
  assert.equal(await inspectPhoto(new File([png], "photo.png", { type: "image/png" })), "image/png");
  await assert.rejects(inspectPhoto(new File([png], "photo.jpg", { type: "image/jpeg" })), GiftError);
  const truncatedJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  await assert.rejects(inspectPhoto(new File([truncatedJpeg], "photo.jpg", { type: "image/jpeg" })), GiftError);
  await assert.rejects(inspectPhoto(new File([png.slice(0, 24)], "photo.png", { type: "image/png" })), GiftError);
  await assert.rejects(inspectPhoto(new File(["<svg />"], "photo.jpg", { type: "image/jpeg" })), GiftError);
  await assert.rejects(inspectPhoto(new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.jpg")), GiftError);
});
