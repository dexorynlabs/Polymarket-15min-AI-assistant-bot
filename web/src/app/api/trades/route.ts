import { NextResponse } from "next/server";
import { loadPaperTradesFromProjectRoot } from "@/server/loadPaperTrades";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const data = loadPaperTradesFromProjectRoot(process.cwd());
    return NextResponse.json(data);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load trades";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
