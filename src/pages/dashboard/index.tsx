import { ProviderStatus } from "./components";
import { PageLayout } from "@/layouts";

const Dashboard = () => {
  return (
    <PageLayout
      title="Dashboard"
      description="Your AI and speech providers at a glance."
    >
      <ProviderStatus />
    </PageLayout>
  );
};

export default Dashboard;
