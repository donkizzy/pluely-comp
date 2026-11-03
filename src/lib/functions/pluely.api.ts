// Helper function to check if Pluely API should be used
// Always returns false - using direct provider curl templates (DeepSeek, OpenAI, etc.)
export async function shouldUsePluelyAPI(): Promise<boolean> {
  return false;
}
