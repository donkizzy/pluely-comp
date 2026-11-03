import { Link } from "react-router-dom";
import { ProviderStatus } from "./components";
import { PageLayout } from "@/layouts";

const Dashboard = () => {
  return (
    <PageLayout
      title="Dashboard"
      description="Your AI and speech providers at a glance."
    >
      <div className="rounded-xl border p-5 space-y-3">
        <h2 className="text-lg font-semibold">Personalize your next interview</h2>
        <p className="text-sm text-muted-foreground">Add your resume, approve real stories, and prepare for the company and role.</p>
        <div className="flex flex-wrap gap-5 text-sm underline">
          <Link to="/onboarding">Get started</Link><Link to="/profile">Your profile</Link><Link to="/stories">Story Bank</Link><Link to="/sessions">Interview sessions</Link>
        </div>
      </div>
      <ProviderStatus />
    </PageLayout>
  );
};

export default Dashboard;
