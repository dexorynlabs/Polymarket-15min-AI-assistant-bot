import { PaperTradingDashboard } from "@/components/PaperTradingDashboard";

export default function Home() {
  return (
    <div className="min-h-full bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <PaperTradingDashboard />
      </div>
    </div>
  );
}
