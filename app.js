const { v4: uuidv4 } = require('uuid');
const net = require('net');
const setTitle = require('console-title');

const server = net.createServer();
const Users = new Map();

server.listen(8080, "127.0.0.1", () => {
    console.log(`tcp server listening on port ${8080}`);
});

function generateID(unavailable) {
    var id = uuidv4();

    while (Array.from(unavailable).includes(id)) {
        id = uuidv4();
    }

    return id;
}

function broadcast(msg, sender) {
    Array.from(Users.keys()).forEach(id => {
        if (id != sender) {
            Users.get(id).COM.write(JSON.stringify(msg) + "@end");
        }
    })
}

function send(id, data) {
    if (Users.has(id)) {
        Users.get(id).COM.write(JSON.stringify(data) + "@end");
    }
}

//#region GameLogic
function clearObjects(target) {
    var iter = Users.get(target).Objects.keys();
    var instanceID = iter.next().value;

    while (instanceID) {
        Destroy(target, instanceID);
        instanceID = iter.next().value;
    }
}
function sendBuffer(target) {
    var uIter = Users.keys();
    var uID = uIter.next().value;

    while (uID) {
        var objIter = Users.get(uID).Objects.keys();
        var objID = objIter.next().value;

        while (objID) {
            var obj = Users.get(uID).Objects.get(objID);
            send(target, { Event: "instantiate", Data: { parent: uID, instanceID: objID, resource: obj.resource, position: obj.position, rotation: obj.rotation } }, undefined);

            objID = objIter.next().value;
        }

        uID = uIter.next().value;
    }
}
function Distance(v0, v1) {
    return Math.sqrt(Math.pow(v0.x - v1.x, 2) + Math.pow(v0.y - v1.y, 2) + Math.pow(v0.z - v1.z, 2));
}
function PlanarDistance(v0, v1) {
    return Math.sqrt(Math.pow(v0.x - v1.x, 2) + Math.pow(v0.z - v1.z, 2));
}
function UserExist(parentID) {
    return Users.get(parentID) != undefined;
}
function ObjectExist(parentID, instanceID) {
    if (UserExist(parentID)) {
        return Users.get(parentID).Objects.has(instanceID);
    } else {
        return false;
    }
}
function Instantiate(parentID, resource, position, rotation, type) {
    return new Promise((resolve, reject) => {
        if (UserExist(parentID)) {
            var instanceID = generateID(Object.keys(Users.get(parentID).Objects));

            //Basic properties
            Users.get(parentID).Objects.set(instanceID, {
                position: position,
                rotation: rotation,
                resource: resource,
            });

            switch (type) {
                case "player":
                    Users.get(parentID).Objects.get(instanceID).life = 100;
                    break;
            }

            broadcast({ Event: "instantiate", Data: { parent: parentID, instanceID: instanceID, resource: resource, position: position, rotation: rotation } }, undefined);
            resolve(instanceID);
        } else {
            reject(parentID);
        }
    });
}
function Destroy(parentID, instanceID) {
    return new Promise((resolve, reject) => {
        if (ObjectExist(parentID, instanceID)) {
            Users.get(parentID).Objects.delete(instanceID);
            broadcast({ Event: "destroy", Data: { parent: parentID, instanceID: instanceID } }, undefined);
            resolve();
        } else {
            reject();
        }
    });
}
function Transform(parentID, instanceID, position, rotation) {
    return new Promise((resolve, reject) => {
        if (ObjectExist(parentID, instanceID)) {
            Users.get(parentID).Objects.get(instanceID).position = position;
            Users.get(parentID).Objects.get(instanceID).rotation = rotation;
            broadcast({ Event: "transform", Data: { parent: parentID, instanceID: instanceID, position: position, rotation: rotation } }, parentID);

            resolve();
        } else {
            reject(`Parent: ${parentID} Object: ${instanceID}`);
        }
    });
}
function OverrideTransform(parentID, instanceID) {
    return new Promise((resolve, reject) => {
        if (ObjectExist(parentID, instanceID)) {
            var position = Users.get(parentID).Objects.get(instanceID).position;
            var rotation = Users.get(parentID).Objects.get(instanceID).rotation;

            send(parentID, { Event: "override_transform", Data: { parent: parentID, instanceID: instanceID, position: position, rotation: rotation } });
            resolve();
        } else {
            reject(`Parent: ${parentID} Object: ${instanceID}`);
        }
    });
}
//#endregion

server.on("connection", (socket) => {
    var id = generateID(Users.keys());
    console.log(`Client joined: ${socket.remoteAddress}:${socket.remotePort} - ${id}`);
    setTitle(`RPGServer - Connections: ${Users.size}`);

    Users.set(id, {
        COM: socket,
        Objects: new Map(),
        stringBuffer: ""
    });

    send(id, { Event: "id", Data: { id: id } });
    sendBuffer(id);

    socket.on("data", (data) => {
        var Sender = Users.get(id);
        Sender.stringBuffer += data.toString("ascii");

        while (Sender.stringBuffer.includes("@end")) {
            var split = Sender.stringBuffer.split("@end");
            Sender.stringBuffer = split[1] ? split[1] + "@end" : "";

            var packet = JSON.parse(split[0]);

            switch (packet.Event) {
                case "uInstantiate":
                    Instantiate(id, packet.Data.resource, packet.Data.position, packet.Data.rotation, "player");
                    break;

                case "uDestroy":
                    Destroy(id, packet.Data.instanceID);
                    break;

                case "uTransform":
                    if (ObjectExist(id, packet.Data.instanceID)) {
                        var mObj = Sender.Objects.get(packet.Data.instanceID);

                        if (PlanarDistance(mObj.position, packet.Data.position) < 1) {
                            Transform(id, packet.Data.instanceID, packet.Data.position, packet.Data.rotation);
                        } else {
                            OverrideTransform(id, packet.Data.instanceID);
                        }
                    }
                    break;

                case "uPing":
                    send(id, { Event: "pong" });
                    break;

                case "uRPC":
                    broadcast({ Event: "rpc", Data: packet.Data }, id);
                    break;

                case "uAttack":
                    if (UserExist(packet.Data.parent, packet.Data.instanceID)) {
                        var targetObject = Users.get(packet.Data.parent).Objects.get(packet.Data.instanceID);
                        var myObject = Sender.Objects.get(packet.Data.mInstanceID);

                        var v0 = targetObject.position;
                        var v1 = myObject.position;

                        if (Distance(v0, v1) <= 2) {
                            targetObject.life -= 25;

                            if (targetObject.life > 0) {
                                broadcast({ Event: "rpc", Data: { parent: packet.Data.parent, instanceID: packet.Data.instanceID, method: "SetAnimTrigger", mode: 2, args: ["AAEAAAD/////AQAAAAAAAAAGAQAAAAZHZXRIaXQL"] } }, id);
                            } else {
                                Destroy(packet.Data.parent, packet.Data.instanceID);
                            }
                        }
                    }
                    break;
            }
        }
    });

    var onEnd = () => {
        if (!Users.get(id))
            return;

        clearObjects(id);
        Users.delete(id);
        console.log(`Client left: ${socket.remoteAddress}:${socket.remotePort} - ${id}`);
        setTitle(`RPGServer - Connections: ${Users.size}`);
    };

    socket.on("close", onEnd);
    socket.on("error", onEnd);
});