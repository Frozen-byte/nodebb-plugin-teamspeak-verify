"use strict";
var user = require.main.require("./src/user"),
    groups = require.main.require('./src/groups'),
    db = require.main.require('./src/database'),
    meta = require.main.require('./src/meta'),
    winston = require('winston'),
    TeamSpeakClient = require('node-teamspeak'),
    middleware = require.main.require('./src/middleware'),
    slugify = require.main.require('./src/slugify');

var plugin = {};

var tsTmpData = {};
var cl = undefined;

var log = {
    "info": function (msg) {
        winston.info("[TSV] " + msg);
    },
    "warn": function (msg) {
        winston.warn("[TSV] " + msg);
    }
};

plugin.sentMessage = function (tsid, msg) {
    if (cl !== undefined) {
        plugin.connect(function () {
            cl.send("clientgetids", {cluid: tsid}, function (err, response, rawResponse) {
                let clid;

                if(Array.isArray(response)) {
                    clid = response[0].clid;
                    log.warn(`found multiple clients for identity, messaging client ${response[0].name} (${clid})`);
                } else {
                    clid = response.clid;
                }

                if (response === undefined) {
                    log.warn("Client not found");
                } else {
                    cl.send("sendtextmessage", {
                        targetmode: 1,
                        target: clid,
                        msg: msg
                    });
                }
            });
        });
        return true;
    } else {
        return false;
    }
};

plugin.addClientToGroup = function (tsid, servergroup) {
    if (cl && tsid && servergroup) {
        plugin.connect(function () {
            cl.send("clientgetdbidfromuid", {cluid: tsid}, function (err, response, rawResponse) {
                if (response === undefined) {
                    log.warn("Client not found");
                } else {
                    if(!Array.isArray(servergroup)) {
                        servergroup = [servergroup];
                    }
                    servergroup.forEach(() => {
                        cl.send("servergroupaddclient", {
                            sgid: servergroup,
                            cldbid: response.cldbid
                        });
                    })
                }
            });
        });
        return true;
    } else {
        return false;
    }
};

plugin.removeClientFromGroup = function (tsid, servergroup) {
    if (cl && tsid && servergroup) {
        plugin.connect(function () {
            cl.send("clientgetdbidfromuid", {cluid: tsid}, function (err, response, rawResponse) {
                if (response === undefined) {
                    log.warn("Client not found");
                } else {
                    if(!Array.isArray(servergroup)) {
                        servergroup = [servergroup];
                    }
                    servergroup.forEach(() => {
                        cl.send("servergroupdelclient", {
                            sgid: servergroup,
                            cldbid: response.cldbid
                        });
                    })
                }
            });
        });
        return true;
    } else {
        return false;
    }
};

// returns an array with all the Teamspeak IDs for the nodeBB Groups the User is in
plugin.getUsersTsGroups = async function (uid, settings) {
    let groupData = await groups.getUserGroups([uid]);
    return groupData[0].map(userGroup => settings[`sgroupid-${userGroup.slug}`]).filter(tsGroup => !!tsGroup);
}

plugin.init = function (data, callback) {
    var hostHelpers = require.main.require('./src/routes/helpers');
    var controllers = require('./static/lib/controllers');

    async function render(req, res, next) {
        res.render('admin/plugins/teamspeak-verify', {
            groups: await groups.getGroupsBySort(),
        });
    }

    plugin.connect(function () {
        log.info("client initialised");
    });

    hostHelpers.setupAdminPageRoute(data.router, '/admin/plugins/teamspeak-verify', [], render);

    data.router.get('/api/admin/plugins/teamspeak-verify', render);


    data.router.get('/api/plugins/teamspeak-verify/generate', middleware.ensureLoggedIn, function (req, res) {
        res.json({error: true, info: "incorrect methode"});
    });
    data.router.post('/api/plugins/teamspeak-verify/generate', middleware.ensureLoggedIn, function (req, res) {
        user.isAdminOrGlobalMod(req.session.passport.user, function (err, isAdminorMod) {
            if (isAdminorMod !== true && req.session.passport.user != req.body.uid) {
                res.json({error: true, info: "invalid user"});
                return;
            }

            user.getUserField(req.body.uid, "email", function (err, email) {
                user.getUserField(req.body.uid, "email:confirmed", function (err, confirmed) {
                    if (!(email.trim().length !== 0 && confirmed === 1)) {
                        res.json({error: true, info: "email not verified"});
                    } else {
                        plugin.isVerified(req.body.uid, function (err, isVerified) {
                            if (isVerified) {
                                res.json({error: true, info: "user already verified"});
                            } else {
                                plugin.getTSIDs(function (err, data) {
                                    if (data.indexOf(req.body.tsid) >= 0) {
                                        res.json({error: true, info: "TS ID already verified"});
                                    } else {
                                        var randomString = Math.random().toString(36).substring(4);
                                        if (plugin.sentMessage(req.body.tsid, randomString)) {
                                            tsTmpData[req.body.uid] = {
                                                tsid: req.body.tsid,
                                                random: randomString
                                            };
                                            res.json({error: false, info: "success"});
                                        } else {
                                            res.json({error: true, info: "internal server error"});
                                        }
                                    }
                                });
                            }
                        });
                    }
                });
            });
        });
    });

    data.router.get('/api/plugins/teamspeak-verify/check', middleware.ensureLoggedIn, function (req, res) {
        res.json({error: true, info: "incorrect methode"});
    });

    data.router.post('/api/plugins/teamspeak-verify/check', middleware.ensureLoggedIn, function (req, res) {
        user.isAdminOrGlobalMod(req.session.passport.user, function (err, isAdminorMod) {
            if (isAdminorMod !== true && req.session.passport.user != req.body.uid) {
                res.json({error: true, info: "invalid user"});
                return;
            }

            meta.settings.get('teamspeak-verify', function (err, settings) {
                if (req.body.uid in tsTmpData && tsTmpData[req.body.uid].tsid === req.body.tsid && tsTmpData[req.body.uid].random === req.body.code) {
                    plugin.getTSIDs(async function (err, data) {
                        if (data.indexOf(req.body.tsid) >= 0) {
                            res.json({error: true, info: "TS ID already verified"});
                        } else {
                            if (err) {
                                log.warn(err);
                                res.json({error: true, info: "internal server error"});
                            }
                            let tsGroups = await plugin.getUsersTsGroups(req.body.uid, settings)
                            plugin.addClientToGroup(req.body.tsid, tsGroups);

                            delete tsTmpData[req.body.uid];
                            res.json({error: false, info: "success"});
                            db.setObjectField('teamspeak-verify:uid:tid', req.body.uid, req.body.tsid, function (err) {
                                if (err == null) {
                                    log.info(`User ${req.body.uid} now associated with ${req.body.tsid}`);
                                } else {
                                    log.warn(`DB Error ${err}`);
                                }
                            });
                        }
                    });
                } else {
                    res.json({error: true, info: "invalid data"});
                }
            });
        });
    });

    data.router.get('/api/plugins/teamspeak-verify/checkUser', middleware.ensureLoggedIn, function (req, res) {
        res.json({error: true, info: "incorrect method"});
    });

    data.router.post('/api/plugins/teamspeak-verify/checkUser', middleware.ensureLoggedIn, function (req, res) {
        plugin.getTSIDs(function (err, data) {
            if (err) {
                log.warn(`checkUser err ${err}`);
            } else if (data.indexOf(req.body.tsid) !== -1) {
                res.json({error: true, info: "TS ID already verified"});
            } else {
                plugin.connect(function () {
                    cl.send("clientgetids", {cluid: req.body.tsid}, function (err, response, rawResponse) {
                        if (err !== undefined) {
                            res.json({error: true, info: "client not found"});
                        } else {
                            res.json({error: false, info: "ok"});
                        }
                    });
                });
            }
        });
    });

    data.router.get('/api/plugins/teamspeak-verify/disassociate/:uid', middleware.ensureLoggedIn, function (req, res) {
        res.json({error: true, info: "incorrect method"});
    });

    data.router.post('/api/plugins/teamspeak-verify/disassociate', middleware.ensureLoggedIn, function (req, res) {
        user.isAdminOrGlobalMod(req.session.passport.user, function (err, isAdminorMod) {
            if (isAdminorMod !== true && req.session.passport.user != req.body.uid) {
                res.json({error: true, info: "invalid user"});
                return;
            }

            meta.settings.get('teamspeak-verify', function (err, settings) {
                plugin.isVerified(req.body.uid, function (err, isVerified) {
                    if (!isVerified) {
                        log.warn("" + req.body.uid + " not verified");
                        res.json({error: true, info: "internal server error"});
                    } else {
                        plugin.get(req.body.uid, async function (err, tsid) {
                            let tsGroups = await plugin.getUsersTsGroups(req.body.uid, settings);
                            plugin.removeClientFromGroup(tsid, tsGroups);
                            res.json({error: false, info: "success"});
                            plugin.delete(req.body.uid, function (err) {
                                if (err == null) {
                                    log.info("User " + req.body.uid + " disassociate - removed TS ID" + tsGroups);
                                } else {
                                    log.warn("DB Error " + err);
                                }
                            });
                        });
                    }
                });
            });
        });
    });

    hostHelpers.setupPageRoute(data.router, '/user/:userslug/teamspeak', [(req, res, next) => {
        setImmediate(next);
    }], controllers.renderSettings);

    callback();
};

plugin.userJoinedGroup = async function (data) {
    const settings = await meta.settings.get('teamspeak-verify');
    const tsGroupIds = data.groupNames.map((groupName) => settings[`sgroupid-${slugify(groupName)}`]).filter(Boolean);
    plugin.get(data.uid, function(err, tsid) {
        if(tsGroupIds.length > 0) {
            plugin.addClientToGroup(tsid, tsGroupIds);
        }
    })
}

plugin.userLeftGroup = async function (data) {
    const settings = await meta.settings.get('teamspeak-verify');
    const tsGroupIds = data.groupNames.map((groupName) => settings[`sgroupid-${slugify(groupName)}`]).filter(Boolean);
    plugin.get(data.uid, function(err, tsid) {
        if(tsGroupIds.length > 0) {
            plugin.removeClientFromGroup(tsid, tsGroupIds);
        }

    })
}

plugin.connect = function (callback) {
    meta.settings.get('teamspeak-verify', function (err, settings) {
        if (cl && cl.send && typeof cl.send === "function") {
            try {
                cl.send("quit");
            } catch (ex) {
                log.warn("connection lost");
            }
        }

        if (err) {
            log.warn(`plugin.connect settings errored ${err}`);
        } else if (settings["server"] && settings["port"] && settings["username"] && settings["password"] && settings["serid"] && settings["queryname"]) {
            cl = new TeamSpeakClient(settings["server"], parseInt(settings["port"]));
            cl.send("login", {client_login_name: settings["username"], client_login_password: settings["password"]});
            cl.send("use", {sid: parseInt(settings["serid"])});
            cl.send("clientupdate", {client_nickname: settings["queryname"]});
            callback();
        } else {
            log.warn(`plugin.connect could not find server data from settings`);
        }
    });
};

plugin.userBanned = function (data, callback) {
    meta.settings.get('teamspeak-verify', function (err, settings) {
        plugin.isVerified(data.uid, function (err, isVerified) {
            if (isVerified) {
                //TODO: ban TS User
            }
        });
    });
};

plugin.updateTitle = function (data, callback) {
    if (data.templateData.url.match(/user\/.+\/teamspeak/)) {
        data.templateData.title = "TeamSpeak";
    }
    callback(null, data);
};

plugin.addMenuItem = function (custom_header, callback) {
    custom_header.plugins.push({
        'route': "/plugins/teamspeak-verify",
        'icon': "fa-microphone",
        'name': "Teamspeak"
    });

    callback(null, custom_header);
};

plugin.addUserSettings = function (data, callback) {
    data.links.push({
        id: 'teamspeak-verify',
        route: 'teamspeak',
        name: 'Teamspeak',
        icon: 'fa-microphone',
        visibility: {
            self: true,
            other: false,
            moderator: false,
            globalMod: false,
            admin: false,
            canViewInfo: false,
        },
    });

    callback(null, data);
};

plugin.getText = function (callback) {
    meta.settings.get('teamspeak-verify', function (err, settings) {
        callback(err, settings["customtext"]);
    });
};

plugin.getUidByUserslug = function (uid, callback) {
    user.getUidByUserslug(uid, callback);
};

plugin.get = function (uid, callback) {
    db.getObjectField('teamspeak-verify:uid:tid', uid, callback);
};

plugin.isVerified = function (uid, callback) {
    db.isObjectField("teamspeak-verify:uid:tid", uid, callback);
};

plugin.getTSIDs = function (callback) {
    db.getObjectValues("teamspeak-verify:uid:tid", callback);
};

plugin.delete = function (uid, callback) {
    db.deleteObjectField("teamspeak-verify:uid:tid", uid, callback);
};

module.exports = plugin;
