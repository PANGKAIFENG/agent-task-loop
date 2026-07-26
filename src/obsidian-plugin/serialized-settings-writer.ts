export class SerializedSettingsWriter<T> {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly persist: (snapshot: T) => Promise<void>) {}

  write(snapshot: T): Promise<void> {
    const write = this.tail.then(
      () => this.persist(snapshot),
      () => this.persist(snapshot),
    );
    this.tail = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }
}
