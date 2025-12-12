import * as grpc from '@grpc/grpc-js';
import { messages } from '@waha/core/engines/gows/grpc/gows';
import { Pool, SizedPool } from '@waha/core/engines/gows/pools';

let CLIENTS: Pool<messages.MessageServiceClient> | null = null;
let STREAM_CLIENTS: Pool<messages.EventStreamClient> | null = null;

export const GetMessageServiceClient = (
  session: string,
  address: string,
  credentials: grpc.ChannelCredentials,
): messages.MessageServiceClient => {
  if (!CLIENTS) {
    const factory = () => {
      return new messages.MessageServiceClient(address, credentials, {
        'grpc.max_send_message_length': 128 * 1024 * 1024,
        'grpc.max_receive_message_length': 128 * 1024 * 1024,
      });
    };
    CLIENTS = new SizedPool(16, factory);
  }
  return CLIENTS.get(session);
};

export const GetEventStreamClient = (
  session: string,
  address: string,
  credentials: grpc.ChannelCredentials,
): messages.EventStreamClient => {
  if (!STREAM_CLIENTS) {
    const factory = () => {
      return new messages.EventStreamClient(address, credentials, {
        'grpc.max_send_message_length': 128 * 1024 * 1024,
        'grpc.max_receive_message_length': 128 * 1024 * 1024,
      });
    };
    STREAM_CLIENTS = new SizedPool(16, factory);
  }
  return STREAM_CLIENTS.get(session);
};
