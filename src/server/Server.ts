
import * as uuid4 from 'uuid/v4';
import * as uuid5 from 'uuid/v5';

import { find, filter, isArray, isUndefined } from 'lodash';

import { DeepstreamWrapper } from '../shared/DeepstreamWrapper';
import { Room, RoomOpts } from './Room';
import { isBoolean } from 'util';

const DS_ROOMINFO_KEY = 'roomInfo';
const DS_ROOMLIST_KEY = 'roomList';
const DS_SINGLE_INSTANCE_KEY = 'roomSingleInstance';

export class ServerOpts {
  resetStatesOnReboot?: any; // boolean | string[]
  deterministicRoomUUID?: boolean;
  serializeByRoomId?: boolean;
  roomsPerWorker?: number;
  namespace?: string;
}

export class Server extends DeepstreamWrapper {

  private roomHash: any = {};
  private runningRoomHash: any = {};
  private runningRooms: number = 0;
  private actionCallbacks: { [key: string]: (data: any, response: deepstreamIO.RPCResponse) => any } = {};
  private clientRooms: { [key: string]: Array<{ name: string, id: string }> } = {};

  private existingSingleInstances = {};

  // TODO killing all room info on reboot will do the same thing
  // TODO resetStatesOnReboot might kill in progress in a multi server setup - should delete only my UUIDs in cleanup
  public resetStatesOnReboot: any = false;
  public serializeByRoomId: boolean = false;
  public deterministicRoomUUID: boolean = false;
  public roomsPerWorker: number = 0;
  public namespace: string = '';

  /**
   * @param {boolean} resetStatesOnReboot - if true, all states will be cleared on reboot. if string[], only those specific states will be reset
   * @param {boolean} serializeByRoomId - if true, state will save per room id instead of per room
   * @param {boolean} deterministicRoomUUID - if true, uuid per room will be the same on subsequent generations
   * @param {number} roomsPerWorker - the maximum number of rooms this server will hold (0 for infinite rooms)
   * @param {string} namespace - if specified, state data will have `namespace` pre-pended
   */
  constructor(
    {
      resetStatesOnReboot,
      serializeByRoomId,
      deterministicRoomUUID,
      roomsPerWorker,
      namespace
    }: ServerOpts = {}
  ) {
    super();
    this.resetStatesOnReboot = resetStatesOnReboot || false;
    this.serializeByRoomId = serializeByRoomId || false;
    this.deterministicRoomUUID = deterministicRoomUUID || false;
    this.roomsPerWorker = roomsPerWorker || 0;
    this.namespace = namespace || '';
  }

  public init(url: string, options?: any): void {
    super.init(url, options);

    if(this.resetStatesOnReboot) {

      if(isArray(this.resetStatesOnReboot)) {
        this.resetStatesOnReboot.forEach(state => {
          this.client.record.getRecord(`${this.namespace}/${state}`).set({});
        });

      } else {
        this.client.record.getRecord(this.namespace).set({});

      }
    }

    this.client.record.getRecord(DS_ROOMINFO_KEY).set({});
    this.client.record.getRecord(DS_ROOMLIST_KEY).set({});
    this.client.record.getRecord(DS_SINGLE_INSTANCE_KEY).set({});

    this.watchSingleInstanceRooms();
    this.watchForBasicEvents();
    this.trackPresence();
    this.setupCleanup();
  }

  public async login(opts: any): Promise<any> {
    const res = await super.login(opts);
    this.watchForAuthenticatedEvents();
    return res;
  }

  /**
   * Register a room named `roomName` and assign it the class prototype `roomProto`.
   * @param {string} roomName
   * @param roomProto
   * @param {RoomOpts} opts
   */
  public registerRoom(roomName: string, roomProto, opts: RoomOpts = {}): void {
    if(this.roomHash[roomName]) throw new Error(`Room ${roomName} already registered on this node.`);

    this.roomHash[roomName] = { roomProto: roomProto, opts };
  }

  /**
   * Unregister `roomName`.
   * @param {string} roomName
   */
  public unregisterRoom(roomName: string): void {
    if(!this.roomHash[roomName]) throw new Error(`Room ${roomName} is not registered on this node.`);
    delete this.roomHash[roomName];
  }

  private createRoom(roomName: string): Room {
    if(!this.roomHash[roomName]) throw new Error(`Room ${roomName} was not registered on this node.`);

    const { roomProto, opts } = this.roomHash[roomName];

    const roomId = this.deterministicRoomUUID ? uuid5(roomName, this.uid) : uuid4();

    // set the state room id to be the room id by default, but if the room wants to override, it can
    let $$roomId = this.serializeByRoomId ? roomId : null;
    if(isBoolean(opts.serializeByRoomId) && !opts.serializeByRoomId) $$roomId = null;

    const roomOpts = {
      roomId,
      roomName,
      onEvent: (event, callback) => this.on(event, callback),
      offEvent: (event, callback) => this.off(event),
      onDispose: () => this.deleteRoom(roomName, roomId),
      onDisconnect: (clientId) => this.leaveRoom(clientId, roomName),
      serverOpts: {
        $$roomId,
        $$serverNamespace: this.namespace,
        $$roomName: roomName
      }
    };

    const roomInst = new roomProto();
    roomInst.setup(this.client, roomOpts);
    roomInst.opts = opts;
    roomInst.init();

    this.runningRooms++;
    this.runningRoomHash[roomName] = this.runningRoomHash[roomName] || {};
    this.runningRoomHash[roomName][roomId] = roomInst;

    if(opts.singleInstance) {
      this.client.record.getRecord(DS_SINGLE_INSTANCE_KEY).set(roomName, this.uid);
    }

    return roomInst;
  }

  public deleteRoom(roomName: string, roomId: string): void {
    if(!this.runningRoomHash[roomName]) throw new Error(`Room ${roomName} does not exist on this node.`);

    this.runningRooms--;
    delete this.runningRoomHash[roomName][roomId];

    if(Object.keys(this.runningRoomHash[roomName]).length === 0) {
      delete this.runningRoomHash[roomName];

      const { opts } = this.roomHash[roomName];
      if(opts.singleInstance) {
        this.client.record.getRecord(DS_SINGLE_INSTANCE_KEY).set(roomName, undefined);
      }
    }
  }

  public on(name: string, callback: (data: any, response: deepstreamIO.RPCResponse) => any): void {
    if(!this.client) throw new Error('Client not initialized');
    this.actionCallbacks[name] = callback;
  }

  public off(name): void {
    if(!this.client) throw new Error('Client not initialized');
    delete this.actionCallbacks[name];
  }

  private hasRunningRoom(roomName: string, roomId?: string): boolean {
    if(!this.runningRoomHash[roomName]) return false;
    if(roomId) return this.runningRoomHash[roomName][roomId];
    return Object.keys(this.runningRoomHash[roomName]).length > 0;
  }

  private isFull(): boolean {
    return this.roomsPerWorker > 0 && this.runningRooms >= this.roomsPerWorker;
  }

  private findRoomToConnectTo(roomName: string, userId: string, roomId?: string): Promise<Room> {
    return new Promise(async (resolve) => {
      const roomHash = this.runningRoomHash;
      const allRooms = Object.keys(roomHash[roomName] || {}) || [];

      if(!allRooms.length) return resolve(null);

      function* nextRoom() {
        for(let i = 0; i < allRooms.length; i++) {
          yield roomHash[roomName][allRooms[i]];
        }
      }

      const gen = nextRoom();

      let chosenRoom = null;

      for(const currentRoom of gen) {
        if(roomId && currentRoom.id !== roomId) continue;
        const canJoin = await currentRoom.canJoin(userId);
        if(canJoin) {
          chosenRoom = currentRoom;
          break;
        }
      }

      resolve(chosenRoom);
    });
  }

  private watchForBasicEvents(): void {

    this.client.rpc.provide('action/user', async (data, response) => {
      const callback = this.actionCallbacks[data.$$action];
      if(!callback) {
        response.error(`Action ${data.$$action} has no registered callback.`);
        return;
      }

      const result = await callback(data, response);

      if(!(<any>response)._isComplete) {
        if(isUndefined(result)) return response.send({ noResult: true });
        response.send(result);
      }
    });

    this.on('rivercut:join', (data, response) => {
      const { room, $$userId, roomId, createNewRoom } = data;

      let joinRoomId = roomId;

      (<any>response).autoAck = false;

      return new Promise(async (resolve) => {

        const ackAndReject = () => {
          response.ack();
          response.reject();

          resolve(null);
        };

        const getResponseData = (room) => {
          const resolveData = {
            statePath: room.state.statePath,
            serverId: this.uid,
            roomId: room.roomId,
            roomName: room.roomName
          };

          resolve(resolveData);
        };

        const sendError = (message: string) => {
          response.error(message);

          resolve(null);
        };

        if(createNewRoom && this.isFull()) {
          return ackAndReject();
        }

        if(!createNewRoom && this.isFull()) {
          // if we don't have a running room, and we're full, there is nowhere to go
          const hasRunningRoom = this.hasRunningRoom(room, joinRoomId);
          if(!hasRunningRoom) return ackAndReject();

          // if we don't have a room to connect to, and we're full, there is nowhere to go
          const roomInst = await this.findRoomToConnectTo(room, $$userId, joinRoomId);
          if(!roomInst) return ackAndReject();

          response.ack();

          // we can connect to a room, so let's try to do that.
          const didJoin = this.joinRoom($$userId, roomInst);
          if(!didJoin) return sendError('Could not join room');

          return getResponseData(roomInst);
        }

        let isRoomFreshlyCreated = false;
        let newRoom: Room = null;

        // ok, we're not full, so lets see if we have a room anyway
        const hasRunningRoom = this.hasRunningRoom(room, joinRoomId);
        if(createNewRoom || (!hasRunningRoom && !joinRoomId)) {
          // see if we can create the room
          const { opts } = this.roomHash[room];

          // single instance rooms need to go through a check to first see if they exist
          if(opts.singleInstance) {
            const doesRoomExist = this.existingSingleInstances[room];
            if(!doesRoomExist) {
              newRoom = this.createRoom(room);
            } else {
              return ackAndReject();
            }

          } else {

            // create a room, we'll see if we can join it
            newRoom = this.createRoom(room);
          }

          if(createNewRoom && newRoom) {
            joinRoomId = newRoom.id;
          }
        }

        // if we don't have a room to connect to, we can make one
        const roomInst = await this.findRoomToConnectTo(room, $$userId, joinRoomId);

        if(!roomInst) {

          // if we can't join anything and we just made a room, get rid of it
          if(newRoom && isRoomFreshlyCreated) newRoom.uninit();

          return ackAndReject();
        }

        response.ack();

        // ok, we have a room, we can try to join it
        const didJoin = this.joinRoom($$userId, roomInst);
        if(!didJoin) return sendError('Could not join room');

        return getResponseData(roomInst);
      })
    });

    this.on('rivercut:leave', async (data, response) => {
      const { $$userId, room } = data;

      const didLeave = this.leaveRoom($$userId, room);
      if(!didLeave) return response.error('Could not leave room');

      return { serverId: this.uid };
    });

    this.on('rivercut:leave-all', (data) => {
      const { $$userId } = data;
      this.leaveAllRooms($$userId);
    });
  }

  private watchForAuthenticatedEvents() {
    this.client.rpc.provide(`action/server/${this.uid}`, async (data, response) => {
      if(!data.$$roomName || !data.$$roomId) {
        response.error('Invalid room name or room id');
        return;
      }

      if(!this.runningRoomHash[data.$$roomName][data.$$roomId]) {
        response.error('Invalid room');
        return;
      }

      const callback = this.actionCallbacks[`${data.$$roomId}.${data.$$action}`];
      if(!callback) {
        response.error(`Action ${data.$$action} has no registered callback for room ${data.$$roomId}.`);
        return;
      }

      const result = await callback(data, response);

      if(!(<any>response)._isComplete) {
        if(isUndefined(result)) return response.send({ noResult: true });
        response.send(result);
      }
    });
  }

  private trackPresence(): void {
    this.client.presence.subscribe((userId, isOnline) => {
      if(!isOnline) {
        this.leaveAllRooms(userId);
      }
    });
  }

  private joinRoom(clientId: string, room: Room): boolean {
    const alreadyInRoom = find(this.clientRooms[clientId], { name: room.name, id: room.id });
    if(alreadyInRoom) return false;

    room.connect(clientId);

    this.clientRooms[clientId] = this.clientRooms[clientId] || [];
    this.clientRooms[clientId].push({ name: room.name, id: room.id });
    return true;
  }

  private leaveRoom(clientId: string, roomName: string): boolean {
    if(!this.clientRooms[clientId]) return false;

    let didLeave = false;

    this.clientRooms[clientId].forEach(({ name, id }) => {
      if(name !== roomName) return;

      const room = this.runningRoomHash[name][id];
      room.disconnect(clientId);
      didLeave = true;
    });

    this.clientRooms[clientId] = filter(this.clientRooms[clientId], ({ name }) => name !== roomName);

    return didLeave;
  }

  private leaveAllRooms(clientId: string): void {
    if(!this.clientRooms[clientId]) return;

    this.clientRooms[clientId].forEach(({ name, id }) => {
      const room = this.runningRoomHash[name][id];
      room.disconnect(clientId);
    });

    delete this.clientRooms[clientId];
  }

  private watchSingleInstanceRooms() {
    this.client.record.getRecord(DS_SINGLE_INSTANCE_KEY).subscribe(data => {
      this.existingSingleInstances = data;
    });
  }

  // TODO this probably doesn't even do anything
  private setupCleanup(): void {
    const callback = () => {
      Object.keys(this.runningRoomHash).forEach(roomName => {
        Object.keys(this.runningRoomHash[roomName]).forEach(roomId => {
          this.runningRoomHash[roomName][roomId].uninit();
        });
      });
    };

    process.on('exit', () => callback());
    process.on('SIGINT', () => callback());
    process.on('SIGUSR1', () => callback());
    process.on('SIGUSR2', () => callback());
  }
}
