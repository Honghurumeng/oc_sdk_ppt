import { NextResponse } from "next/server";
import { reloadOpencodeHandle } from "@/lib/opencode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const res = await reloadOpencodeHandle();
  if (!res.ok) {
    return NextResponse.json(res, { status: 400 });
  }
  return NextResponse.json(res);
}
