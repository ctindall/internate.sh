#!/usr/bin/node

var child_process = require("child_process");
var fs = require("fs");
var requestsync = require("request-sync");
var rando = (new (require("random-js"))());

var docker_binary = "/usr/bin/docker";

var config = JSON.parse(fs.readFileSync(process.env.HOME + "/.luigi.json"));
var sites = config.sites;

//TODO: throw error if there are two sites with the same lable
//TODO: throw error if any of the sites are missing require elements

function getSite(label) {
    site = sites.filter(function(s) {
	if(label === s.label) {
	    return true;
	}
    })[0];

    if(!site) {
	site = sites[0];
    }
    
    if (!site.email) {
	site.email = config.global.email;
    }

    if (!site.host_server) {
	site.host_server = config.global.host_server;
    }

    site.ip = shellOut("docker-machine ip '"  + site.host_server + "'","Fetching IP address for server '" + site.host_server + "'").replace(/\n$/, "");
		
    return site;
}

function setDNS(domain, ip) {

    var name = "@"; 

    if(domain.match(/\./g).length > 1) {
	//this is a subdomain
	name = domain + ".";
	domain  = domain.match(/[a-zA-Z-]*\.[a-zA-Z]*$/)[0];
    }

    //get all domains, so we can find out if this one even exists
    var options = {
	url: "https://api.digitalocean.com/v2/domains",
	method: "GET",
	headers: { "Authorization" : "Bearer " + config.global.digital_ocean_token }
    }

    domains = JSON.parse(requestsync(options).body).domains.filter(function(d) {
	console.log(d.name);
	if(d.name === domain) {
	    return true;
	} else {
	    return false;
	}
    });
    
    if (domains.length < 1) { //domain doesn't exist, so we have to create it
	var options = {
	    url: "https://api.digitalocean.com/v2/domains",
	    method: "POST",
	    headers: { "Authorization" : "Bearer " + config.global.digital_ocean_token },
	    qs: {
		name: domain,
		ip_address: site.ip
	    }
	}
    }
    
    
    //get all records for the domain
    var options = {
	url: "https://api.digitalocean.com/v2/domains/" + domain + "/records",
	method: "GET",
	headers: { "Authorization" : "Bearer " + config.global.digital_ocean_token } 
    }
    console.log("Ascertaining current state of domain by sending the following request to Digital Ocean:\n" + JSON.stringify(options, null, "\t"));    
    var response = JSON.parse(requestsync(options).body);
    console.log(response);

    records = response.domain_records.filter(function(record) { // get just the A records for "@" or the relevant subdomain
	if (record.type !== "A") {
	    return false;
	}

	if(record.name !== name && !name.includes(record.name)) {
	    return false;
	} 

	return true;
    })

    if(records.length > 0 ) { //there is already an A record, so let's update it
	    records.forEach(function(record) {
		var options = {
		    url: "https://api.digitalocean.com/v2/domains/" + domain + "/records/" + record.id,
		    method: "PUT",
		    headers: { "Authorization" : "Bearer " + config.global.digital_ocean_token },
		    qs: {
			type: "A",
			name: name,
			data: site.ip
		    }
		};

		console.log("Setting DNS for " + domain + " to '"  + site.ip + "' with this request to Digital Ocean:\n" + JSON.stringify(options, null, "\t"));
		console.log(requestsync(options));
	    });
    } else { // there is no A record, so we have to create a new one
	console.log("Creating new record for '" + name + "' in the zone '" + domain + "'");
	console.log(requestsync({
	    url: "https://api.digitalocean.com/v2/domains/" + domain + "/records",
	    method: "POST",
	    headers: { "Authorization" : "Bearer " + config.global.digital_ocean_token },
	    qs: {
		type: "A",
		name: name,
		data: site.ip
	    }
	}));
    }
    
    console.log(response);
}

function findFreePorts(num, server) {
    console.log("Finding free ports on " + server + ".");

    function isPortFree(port, server) {
	results = child_process.spawnSync("docker-machine ssh " + server + " 'netstat -tulpn | grep \"\:" + port + "\"'");

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

function createWorkingDirectory(site) {
    tmpdir = shellOut("mktemp -d", "Creating tmpdir").replace(/\n$/, "") + "/work";
    shellOut("cp -r '" + site.site_dir + "' " + tmpdir, "Copying files to work directory " + tmpdir);

    return tmpdir;
}

function buildDockerImage(site) {
    site.docker_tag = site.label;

    site.content_groups.forEach(function(content_group) {
	site.docker_tag = site.docker_tag + "-" + content_group.external_port;
    })

    if(!site.build_command) {
	site.build_command = "/bin/true";
    }
    
    cmd = 'eval $(docker-machine env --shell bash "' + site.host_server + '")' + " && cd " + site.work_dir + " && " + site.build_command + " && " + docker_binary + " build -t '" + site.docker_tag + "' ./";
    
    shellOut(cmd, "Building Docker image");

    //TODO throw error if build fails
}

function startDockerImage(site) {
    port_switch = "";
    site.content_groups.forEach(function(content_group) {
	port_switch = port_switch + " -p 127.0.0.1:" + content_group.external_port + ":" + content_group.internal_port + " ";
    })

    cmd = 'eval $(docker-machine env --shell bash "' + site.host_server + '")' + " && cd " + site.site_dir + " && "+ docker_binary + " run " + port_switch + " --restart=always -d --name " + site.docker_tag + " " + site.docker_tag;
    
    shellOut(cmd, "Starting Docker container");
}

function makeApacheConf(site) {
    function makeVhost(domain, internal_port, external_port, email) {
	return  "\n<VirtualHost *:80>\n" +
	    "ServerAdmin " + email + "\n" +
	    "ServerName " + domain +"\n" +
	    
        "ErrorLog ${APACHE_LOG_DIR}/" + domain + "-error.log\n" +
	    "CustomLog ${APACHE_LOG_DIR}/" + domain + "-access_log common\n" +
	    
        "ProxyPass / http://127.0.0.1:" + external_port + "/\n" +
	    "ProxyPassReverse / http://127.0.0.1:" + external_port + "/\n" +
	    "</VirtualHost>\n";
    }

    vhosts = site.content_groups.map(function (content_group) {
	return content_group.domains.map(function(domain) {
	    return makeVhost(domain, content_group.internal_port, content_group.external_port, content_group.email);
	}).join("");
    })

    conf = vhosts.join("");

    // if(site.paid_domains) {
    // 	//paid domains
    // 	vhosts = site.paid_domains.map(function(d) {
    // 	    return makeVhost(d, site.paidport, site.email);
    // 	});
    // 	conf = conf + vhosts.join("");
    // }

    return conf;
}

function enableSite(site) {
    tmpfilename = "/tmp/" + process.pid + "-" + site.label + ".conf";
    fs.writeFileSync(tmpfilename, conf);
    console.log("Wrote Apache conf to: " + tmpfilename);

    filename = site.host_server + ":/etc/apache2/sites-available/" + site.label + ".conf";
   
    shellOut("docker-machine scp " + tmpfilename + " " + filename,
	     "Transferring " + tmpfilename + " to " + filename);

    shellOut("docker-machine ssh " + site.host_server + " a2ensite " + site.label + ".conf",
	     "Enabling site");

    shellOut("docker-machine ssh " + site.host_server + " service apache2 reload",
	     "Reloading Apache on " + site.host_server);
}

function shellOut(cmd, msg) {
    if(msg) {
	console.log(msg + " by executing this command:\n====>" + cmd);
    } else {
	console.log("Executing the following command:\n====>" + cmd);
    }

    output = child_process.execSync(cmd).toString();

    console.log(output + "\n\n");
    return output;
}

function isLocked() {
    return fs.existsSync("/tmp/luigi.lck");
}

function waitForLock() {
    while(isLocked()) {
	console.log("Waiting 5 seconds for lock...");
	shellOut("sleep 5");
    }
}

function createLock() {
    shellOut("echo '" + process.pid + "' > /tmp/luigi.lck");    
}

function removeLock() {
    shellOut("rm -fv /tmp/luigi.lck");
}

waitForLock();
createLock();


// 1) interpret the first argument as a "label" and find that site object in ~/.luigi.json
site = getSite(process.argv[2]);


// 2) for each site, find the number of content groups. find a number of free nonprivileged ports on the target server equal to this number and store them, assigning one to each content group

external_ports = findFreePorts(site.content_groups.length, site.host_server);

site.content_groups = site.content_groups.map(function(content_group) {
    content_group.external_port = external_ports.pop();
    return content_group;
})

// 2.5) create a temporary working directory:

site.work_dir = createWorkingDirectory(site);


// 3) build the site_dir, tagging the image in the form "$label-$freeport-$paidport"

buildDockerImage(site);
    
// 4) start the docker image, mapping internal port 80 to $freeport, and internal port 81 to $paidport

startDockerImage(site);

// 5) generate an httpd.conf file for the site

site.conf = makeApacheConf(site);

// 6) After generating the conf, move it to /etc/apache2/sites-available/$label.conf on the hosting server, enable it (a2enable), and reload the apache config ("service apache2 reload")

enableSite(site);

//6.5) set the DNS for each domain to the proper IP via the DO API:

site.content_groups.forEach(function(content_group) {
    content_group.domains.forEach(function(domain) {
	setDNS(domain, site.ip);
    });
});

// 7) Finally, find other running docker containers whose label is of the form /$label\-[0-9]+\-[0-9]+/ (aka "hot-stock-tips-4038-3994") and stop them.

cmd = 'eval $(docker-machine env --shell bash "' + site.host_server + '") && ' + docker_binary + " ps | awk '{print $NF}' | sed '1d'";
to_kill = shellOut(cmd)
    .split("\n")
    .filter(function(x) {
	if(x.includes(site.label) && x != site.docker_tag) {
	    return true;
	} else {
	    return false;
	}
    });

to_kill.forEach(function(x) {
    shellOut('eval $(docker-machine env --shell bash "' + site.host_server + '") && ' + docker_binary + " stop " + x,
	     "Stopping container " + x + " on " + site.host_server );
});

// 7.5) clean up tmpdir and remove lockfile

shellOut("rm -rf '" + site.work_dir + "'", "Cleaning up tmpdir");

removeLock();

// 8) Clean up unused docker images.

shellOut("clear_docker_images.sh '" + site.host_server + "'", "Removing unnecessary docker images and containers");
