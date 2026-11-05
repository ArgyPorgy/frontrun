export const metadata = { title: "Offline" };

export default function OfflinePage() {
  return (
    <div className="px-6 py-20 text-center">
      <h1 className="text-xl font-semibold">You&apos;re offline</h1>
      <p className="mt-2 text-muted">Prices and trades need a connection. Reconnect and pull to refresh.</p>
    </div>
  );
}
