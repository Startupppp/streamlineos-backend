import { EventEmitter } from "node:events";
import net from "node:net";
import { ClamAvScanner } from "./clamd-av-scanner";

jest.mock("node:net");

const mockedNet = net as jest.Mocked<typeof net>;

class FakeSocket extends EventEmitter {
  destroyed = false;
  written: Buffer[] = [];

  write(chunk: Buffer | string): boolean {
    this.written.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    return true;
  }

  setTimeout(_ms: number): this {
    return this;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function makeSocket(response: string): FakeSocket {
  const socket = new FakeSocket();
  mockedNet.createConnection.mockReturnValue(socket as unknown as net.Socket);

  setImmediate(() => {
    socket.emit("connect");
    setImmediate(() => {
      socket.emit("data", Buffer.from(response));
      socket.emit("end");
    });
  });

  return socket;
}

describe("ClamAvScanner", () => {
  let scanner: ClamAvScanner;

  beforeEach(() => {
    jest.resetAllMocks();
    scanner = new ClamAvScanner("127.0.0.1", 3310);
  });

  it("returns clean for a safe file", async () => {
    makeSocket("stream: OK\n");
    const result = await scanner.scan(Buffer.from("safe"), "file.pdf", "application/pdf");
    expect(result).toEqual({ status: "clean" });
  });

  it("returns infected with the threat name when FOUND", async () => {
    makeSocket("stream: Eicar-Test-Signature FOUND\n");
    const result = await scanner.scan(Buffer.from("eicar"), "eicar.com", "text/plain");
    expect(result).toEqual({ status: "infected", threat: "Eicar-Test-Signature" });
  });

  it("returns error when clamd is unreachable", async () => {
    const socket = new FakeSocket();
    mockedNet.createConnection.mockReturnValue(socket as unknown as net.Socket);

    setImmediate(() => {
      socket.emit("error", new Error("ECONNREFUSED"));
    });

    const result = await scanner.scan(Buffer.from("data"), "file.jpg", "image/jpeg");
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.reason).toContain("clamd-unreachable");
  });

  it("sends INSTREAM command to clamd", async () => {
    const socket = makeSocket("stream: OK\n");
    await scanner.scan(Buffer.from("hello"), "hi.txt", "text/plain");

    const allWritten = Buffer.concat(socket.written).toString();
    expect(allWritten).toContain("nINSTREAM");
  });

  it("terminates the stream with a zero-length chunk", async () => {
    const socket = makeSocket("stream: OK\n");
    await scanner.scan(Buffer.from("hello"), "hi.txt", "text/plain");

    const last = socket.written[socket.written.length - 1];
    expect(last).toBeDefined();
    if (last) expect(last.readUInt32BE(0)).toBe(0);
  });
});
