'use strict';

define('admin/plugins/teamspeak-verify', ['settings'], function (Settings) {
    /* globals $, app, socket, require */

    var ACP = {};

    ACP.init = function () {
        Settings.load('teamspeak-verify', $('.teamspeak-verify-settings'));

        $('#save').on('click', function () {
            Settings.save('teamspeak-verify', $('.teamspeak-verify-settings'), function () {
                app.alert({
                    type: 'success',
                    alert_id: 'teamspeak-verify-saved',
                    title: 'Settings Saved',
                    message: 'Please reload your NodeBB to apply these settings',
                    clickfn: function () {
                        socket.emit('admin.reload');
                    }
                });
            });
        });
    };

    return ACP;
});