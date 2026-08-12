export async function retryOnce<T>(operation: () => Promise<T>, delayMs = 250): Promise<T> {
  try {
    return await operation();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return operation();
  }
}
