import Link from 'next/link';

function currentAdventDay(): number | null {
  const now = new Date();
  return now.getMonth() === 11 ? Math.min(now.getDate(), 25) : null;
}

export default function Home() {
  const day = currentAdventDay();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-paper px-6 text-ink">
      <span className="text-sm text-pine">
        {day ? `Day ${day} of 25` : 'Not December yet'}
      </span>
      <h1 className="max-w-md text-center text-3xl font-medium sm:text-4xl">
        Advent Challenge
      </h1>
      <p className="max-w-sm text-center text-[#5c5c5c]">
        Base scaffold is live. Backend and frontend are wired up and ready for
        the first day&apos;s build.
      </p>
      <Link href="/chat" className="text-pine underline">
        Try the chat →
      </Link>
    </main>
  );
}
