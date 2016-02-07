#!/usr/bin/node

var fs = require("fs");
var child_process = require("child_process");
var rando = (new (require("random-js"))());


var docker_binary = "/usr/local/bin/docker-1.6.2";
var hostingserver = "billipede.net";

var sites = JSON.parse(fs.readFileSync(process.env.HOME + "/.luigi.json"));

//TODO: throw error if there are two sites with the same lable
//TODO: throw error if any of the sites are missing require elements

function getSite(label) {
    return sites.filter(function(s) {
	if(label === s.label) {
	    return true;
	}
    })[0];
}

function findFreePorts(num, server) {
    console.log("Finding free ports on " + server + ".");

    function isPortFree(port, server) {
	results = child_process.spawnSync("ssh root@" + server + " 'netstat -tulpn | grep \"\:" + port + "\"'");

	if (results.status === 0) { //$? is 0, so the grep found something, meaning that the port is in use
	    return false;
	} else {
	    return true;
	}
    }
    
    ports = [];
    
    while (ports.length < num) {
	possible_port = rando.integer(7000,8000);

	if ( (ports.indexOf(possible_port) == -1) && isPortFree(possible_port, server)) {
	    ports.push(possible_port);
	}
    }

    console.log("Found " + ports);
    
    return ports;
}

//1) interpret the first argument as a "label" and find that site object in ~/.luigi.json
site = getSite("merger-filings");

//2) query the hosting server/docker daemon and find two free nonprivileged ports, one for the free site, the other for the paid site.
ports = findFreePorts(2, hostingserver);
freeport = ports[0];
paidport = ports[1];

//3) build the site_dir, tagging the image in the form "$label-$freeport-$paidport"

docker_tag = site.label + "-" + freeport + "-" + paidport;

cmd = "cd " + site.site_dir + " && " + docker_binary + " build -t '" + docker_tag + "' ./";

console.log(child_process.execSync(cmd).toString());

