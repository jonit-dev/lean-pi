/**
 * The PNG codec the screenshot verifier compares through (PRD-022 Phase 2).
 *
 * A capture arrives as PNG bytes and the diff has to be written back as one, so
 * this module is a decoder plus an encoder and nothing else: 8-bit,
 * non-interlaced images of color type 0/2/4/6 (grey, RGB, grey+alpha, RGBA),
 * normalized to RGBA8. Palette and 16-bit images are rejected by name rather
 * than decoded wrongly.
 *
 * ponytail: hand-rolled instead of `pixelmatch` + `pngjs` because neither is
 * installed and this package ships zip-less: no per-pixel perceptual color
 * distance, no anti-alias detection, no gamma handling. Upgrade to
 * pixelmatch+pngjs the day AA flicker produces a false screenshot failure.
 */
import { crc32, deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** RGB channel pairs. `screenshot_compare` speaks RGBA8 and translates on the way in. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export class PngError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PngError";
	}
}

export interface DecodedPng {
	width: number;
	height: number;
	/** Row-major RGBA8, `width * height * 4` bytes. */
	rgba: Uint8Array;
}

function paeth(left: number, up: number, upLeft: number): number {
	const estimate = left + up - upLeft;
	const toLeft = Math.abs(estimate - left);
	const toUp = Math.abs(estimate - up);
	const toUpLeft = Math.abs(estimate - upLeft);
	if (toLeft <= toUp && toLeft <= toUpLeft) return left;
	return toUp <= toUpLeft ? up : upLeft;
}

/** Reverse the per-scanline filters in place; `raw` is inflate output with one filter byte per row. */
function unfilter(raw: Buffer, height: number, stride: number, channels: number): Uint8Array {
	const out = new Uint8Array(stride * height);
	let source = 0;
	for (let y = 0; y < height; y += 1) {
		const filter = raw[source]!;
		const row = out.subarray(y * stride, (y + 1) * stride);
		const prior = y === 0 ? undefined : out.subarray((y - 1) * stride, y * stride);
		for (let x = 0; x < stride; x += 1) {
			const value = raw[source + 1 + x]!;
			const left = x >= channels ? row[x - channels]! : 0;
			const up = prior === undefined ? 0 : prior[x]!;
			const upLeft = prior === undefined || x < channels ? 0 : prior[x - channels]!;
			const predictor =
				filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
			if (filter > 4) throw new PngError(`unsupported PNG scanline filter ${filter}`);
			row[x] = (value + predictor) & 0xff;
		}
		source += stride + 1;
	}
	return out;
}

/** Decode a PNG to RGBA8. Throws `PngError` for anything this codec does not cover. */
export function decodePng(bytes: Uint8Array | Buffer): DecodedPng {
	const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
	if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new PngError("not a PNG: the signature is missing");
	let offset = 8;
	let width = 0;
	let height = 0;
	let channels = 0;
	const idat: Buffer[] = [];
	let seated = false;
	while (offset + 8 <= buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString("ascii", offset + 4, offset + 8);
		const body = offset + 8;
		const end = body + length;
		if (end + 4 > buffer.length) throw new PngError(`truncated PNG: chunk ${type} runs past the end of the file`);
		const data = buffer.subarray(body, end);
		if (type === "IHDR") {
			if (length < 13) throw new PngError("malformed PNG: IHDR is shorter than 13 bytes");
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			const depth = data[8]!;
			const color = data[9]!;
			const interlace = data[12]!;
			if (depth !== 8) throw new PngError(`unsupported PNG bit depth ${depth}: only 8-bit images are compared`);
			if (CHANNELS[color] === undefined) throw new PngError(`unsupported PNG color type ${color}: palette images are not compared`);
			if (interlace !== 0) throw new PngError("unsupported interlaced PNG");
			channels = CHANNELS[color]!;
			seated = true;
		} else if (type === "IDAT") idat.push(Buffer.from(data));
		else if (type === "IEND") break;
		offset = end + 4;
	}
	if (!seated) throw new PngError("malformed PNG: no IHDR chunk");
	if (width === 0 || height === 0) throw new PngError("malformed PNG: zero-sized image");
	if (idat.length === 0) throw new PngError("malformed PNG: no IDAT data");
	const stride = width * channels;
	const raw = inflateSync(Buffer.concat(idat));
	if (raw.length < (stride + 1) * height) throw new PngError("truncated PNG: the inflated pixel data is shorter than the header declares");
	const rows = unfilter(raw, height, stride, channels);
	const rgba = new Uint8Array(width * height * 4);
	const pixels = width * height;
	for (let index = 0; index < pixels; index += 1) {
		const source = index * channels;
		const target = index * 4;
		if (channels === 4) {
			rgba.set(rows.subarray(source, source + 4), target);
			continue;
		}
		if (channels === 3) {
			rgba[target] = rows[source]!;
			rgba[target + 1] = rows[source + 1]!;
			rgba[target + 2] = rows[source + 2]!;
			rgba[target + 3] = 255;
			continue;
		}
		// Grey (1 channel) and grey+alpha (2): one sample drives all three channels.
		rgba[target] = rows[source]!;
		rgba[target + 1] = rows[source]!;
		rgba[target + 2] = rows[source]!;
		rgba[target + 3] = channels === 2 ? rows[source + 1]! : 255;
	}
	return { width, height, rgba };
}

function chunk(type: string, data: Buffer): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "ascii");
	const tail = Buffer.alloc(4);
	tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0, 0);
	return Buffer.concat([head, data, tail]);
}

export interface EncodePngOptions {
	/** Written as a `tEXt` `Comment` chunk, so the artifact is self-describing. */
	text?: string;
}

/** Encode RGBA8 back to a PNG. */
export function encodePng(width: number, height: number, rgba: Uint8Array, options: EncodePngOptions = {}): Buffer {
	if (rgba.length !== width * height * 4) throw new PngError(`RGBA buffer is ${rgba.length} bytes, expected ${width * height * 4}`);
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	const rows = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y += 1) {
		const target = y * (width * 4 + 1);
		rows[target] = 0;
		Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(rows, target + 1);
	}
	const parts = [SIGNATURE, chunk("IHDR", header)];
	if (options.text !== undefined) parts.push(chunk("tEXt", Buffer.from(`Comment\0${options.text}`, "latin1")));
	parts.push(chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0)));
	return Buffer.concat(parts);
}

export interface PixelDiff {
	differing: number;
	total: number;
	/** `differing / total`, the number a threshold is compared against. */
	ratio: number;
	/** RGBA8 image with the differing pixels painted red; unchanged pixels are dimmed. */
	diff: Uint8Array;
}

export interface PixelDiffOptions {
	/** Per-channel distance (0–1) above which a pixel counts as different. Default 0.1, as pixelmatch's. */
	colorThreshold?: number;
}

/**
 * Compare two decoded captures pixel by pixel. Dimensions must match: a diff of
 * two differently sized images has no meaning, so the caller reports that as a
 * named failure instead.
 */
export function pixelDiff(a: DecodedPng, b: DecodedPng, options: PixelDiffOptions = {}): PixelDiff {
	if (a.width !== b.width || a.height !== b.height) {
		throw new PngError(`screenshot dimensions differ: baseline ${a.width}x${a.height}, capture ${b.width}x${b.height}`);
	}
	const tolerance = Math.round((options.colorThreshold ?? 0.1) * 255);
	const diff = new Uint8Array(a.rgba.length);
	const pixels = a.width * a.height;
	let differing = 0;
	for (let index = 0; index < pixels; index += 1) {
		const at = index * 4;
		let distance = 0;
		for (let channel = 0; channel < 4; channel += 1) {
			distance = Math.max(distance, Math.abs(a.rgba[at + channel]! - b.rgba[at + channel]!));
		}
		if (distance > tolerance) {
			differing += 1;
			diff[at] = 255;
			diff[at + 1] = 0;
			diff[at + 2] = 0;
			diff[at + 3] = 255;
			continue;
		}
		diff[at] = b.rgba[at]!;
		diff[at + 1] = b.rgba[at + 1]!;
		diff[at + 2] = b.rgba[at + 2]!;
		diff[at + 3] = 64;
	}
	return { differing, total: pixels, ratio: pixels === 0 ? 0 : differing / pixels, diff };
}
