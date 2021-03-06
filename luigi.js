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

function log(msg) {
    console.log(msg);
    msg = (new Date()).toISOString() + "|" + process.pid + "|" + msg;
    fs.appendFileSync("/home/cam/luigi.log", msg);
}

function scheduleKill(server, label, time) {
    var cmd = 'eval $(docker-machine env --shell bash "' + server + '") && ' + docker_binary + " ps | awk '{print $NF}' | sed '1d'";
    var to_kill = shellOut(cmd)
	.split("\n")
	.filter(function(x) {
	    if(x.includes(site.label) && x != site.docker_tag) {
		return true;
	    } else {
		return false;
	    }
	});
    
    to_kill.forEach(function(x) {
	shellOut("docker-machine ssh " + server + " 'echo \"docker stop " + label + "\" | at \"" + time +"\"'",
		 "Scheduling the destruction of the old container on " + server + " at '" + time + "'");
    });
}

function editSiteParameter(site, parameter, value) {
    site[parameter] = value;

    sites = sites.map(function(s) {
	if (site.label == s.label) {
	    return site;
	} else {
	    return s;
	}
    });

    config.sites = sites;

    fs.writeFileSync(process.env.HOME + "/.luigi.json", JSON.stringify(config, null, "\t"));
}

function getServerIp(server) {
    return shellOut("docker-machine ip '"  + server + "'","Fetching IP address for server '" + server + "'").replace(/\n$/, "");
}

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

    site.ip = getServerIp(site.host_server);
		
    return site;
}

function setDNS(domain, ip, type, priority) {

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
	log(d.name);
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
		ip_address: ip
	    }
	}
    }
    
    
    //get all records for the domain
    var options = {
	url: "https://api.digitalocean.com/v2/domains/" + domain + "/records",
	method: "GET",
	headers: { "Authorization" : "Bearer " + config.global.digital_ocean_token } 
    }
    log("Ascertaining current state of domain by sending the following request to Digital Ocean:\n" + JSON.stringify(options, null, "\t"));    
    var response = JSON.parse(requestsync(options).body);
    log(JSON.stringify(response));

    records = response.domain_records.filter(function(record) { // get just the A records for "@" or the relevant subdomain
	if (record.type !== type) {
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
			type: type,
			name: name,
			data: ip,
			priority: priority
		    }
		};

		log("Setting DNS for " + domain + " to '"  + ip + "' with this request to Digital Ocean:\n" + JSON.stringify(options, null, "\t"));
		log(JSON.stringify(requestsync(options)));
	    });
    } else { // there is no A record, so we have to create a new one
	log("Creating new record for '" + name + "' in the zone '" + domain + "'");
	log(JSON.stringify(requestsync({
	    url: "https://api.digitalocean.com/v2/domains/" + domain + "/records",
	    method: "POST",
	    headers: { "Authorization" : "Bearer " + config.global.digital_ocean_token },
	    qs: {
		type: type,
		name: name,
		data: ip,
		priority: priority
	    }
	})));
    }
    
    log(JSON.stringify(response));
}

function findFreePorts(num, server) {
    log("Finding free ports on " + server + ".");

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

    log("Found " + ports);
    
    return ports;
}

function createWorkingDirectory(site) {
    tmpdir = shellOut("mktemp -p ~/tmp -d", "Creating tmpdir").replace(/\n$/, "") + "/work";
    shellOut("cp -r '" + site.site_dir + "' " + tmpdir, "Copying files to work directory " + tmpdir);
    shellOut("echo '" + process.pid + "' > " + tmpdir + "/pid");

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
    log("Wrote Apache conf to: " + tmpfilename);

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
	log(msg + " by executing this command:\n====>" + cmd);
    } else {
	log("Executing the following command:\n====>" + cmd);
    }

    output = child_process.execSync(cmd).toString();

    log(output.replace(/^/gm, "->"));
    return output;
}

function pidRunning(pid) {
    var filename = "/proc/" + pid;

    console.log(shellOut("bash -c 'if [ -e \"" + filename + "\" ]; then echo true; else echo false; fi'") + "|");
    
    if( shellOut("bash -c 'if [ -e \"" + filename + "\" ]; then echo true; else echo false; fi'", "Determining whether PID '" + pid  + "' is currently running").replace(/\n$/, "") == "true") {
	return true;
    }

    return false;
}

function isLocked() {
    var filename = "/tmp/luigi.lck";
    var exists = fs.existsSync(filename);

    if (exists) {
	var lockpid = fs.readFileSync(filename).toString().replace(/\n$/, "");
	var isme = (process.pid == lockpid);
	var isrunning = pidRunning(lockpid);
    }

    log(JSON.stringify({
	exists: exists,
	isme: isme,
	isrunning: isrunning
    }));
    
    if (!exists) {
	return false;
    }

    if (exists && isme) {
	return false;
    }

    if (exists && !isme && !isrunning) {
	removeLock();
	return false;
    }
    
    return true;
}

function waitForLock() {
    while(isLocked()) {
	log("Waiting 5 seconds for lock...");
	shellOut("sleep 5");
    }
}

function createLock() {
    shellOut("echo '" + process.pid + "' > /tmp/luigi.lck");    
}

function removeLock() {
    shellOut("rm -fv /tmp/luigi.lck");
}

function buildSite(site) {
    // for each site, find the number of content groups. find a number of free nonprivileged ports on the target server equal to this number and store them, assigning one to each content group
    
    external_ports = findFreePorts(site.content_groups.length, site.host_server);

    site.content_groups = site.content_groups.map(function(content_group) {
	content_group.external_port = external_ports.pop();
	return content_group;
    })
    
    site.work_dir = createWorkingDirectory(site);

    buildDockerImage(site);

    shellOut("rm -rf '" + site.work_dir + "'", "Cleaning up tmpdir");
    
    startDockerImage(site);

    site.conf = makeApacheConf(site);

    enableSite(site);

    site.content_groups.forEach(function(content_group) {
	content_group.domains.forEach(function(domain) {
	    setDNS(domain, site.ip, "A");
	});
    });

    // find other running docker containers whose label is of the form /$label\-[0-9]+\-[0-9]+/ (aka "hot-stock-tips-4038-3994") and stop them.
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
}

function createMailDomainFile(domain) {
    var mailboxes = config.mail[domain].mailboxes;
    if(!mailboxes) {
	mailboxes = [];
    }
    var server = config.mail[domain].mail_server;

    var dir = process.env.HOME + "/.luigi/mail/" + server + "/domains/" 
    var filename = dir + domain;

    shellOut("mkdir -p " + dir);
    
    fs.writeFileSync( filename,
 		      mailboxes.map(function(mailbox) {
			  return mailbox.local_part + ": \n";
		      }).join(""));

    return filename;
}

function createMailPasswdFile() {
    var mailboxes = config.mail[domain].mailboxes;
    if(!mailboxes) {
	mailboxes = [];
    }

    var dir = process.env.HOME + "/.luigi/mail/" + server + "/auth/" + domain + "/";
    var filename = dir + "passwd";

    shellOut("mkdir -p " + dir);

    fs.writeFileSync( filename,
		      mailboxes.map(function(mailbox) {
			  return mailbox.local_part + ":{" + mailbox.pass_scheme + "}" + mailbox.pass + "::::::\n";
		      })
		      .join("")
		    );

    return filename;
}

function uploadFile(local_filename, server, remote_directory) {
    shellOut("docker-machine ssh " + server + " mkdir -p " + remote_directory);
    shellOut("docker-machine scp " + local_filename + " " + server + ":" + remote_directory + "/");
}

log("invocation arguments: " + JSON.stringify(process.argv))
waitForLock();
createLock();

cmd = process.argv[2];

if ( cmd === "build" ) {
    site = getSite(process.argv[3]);
    buildSite(site);
    shellOut("clear_docker_images.sh '" + site.host_server + "'", "Removing unnecessary docker images and containers");
} else if ( cmd === "move" ) {
    //luigi.js move $label $new_server
    site = getSite(process.argv[3]);
    new_server = process.argv[4];
    old_server = site.host_server;
    
    editSiteParameter(site, "host_server",  new_server);
    buildSite(site);
    scheduleKill(old_server, site.label, "now + 2 hours");
    shellOut("clear_docker_images.sh '" + site.host_server + "'", "Removing unnecessary docker images and containers from the old server '" + old_server+ "'");
} else if (cmd === "create-mailboxes") {
    domain = process.argv[3];
    server = config.mail[domain].mail_server;

    //make sure A records point to the correct IP
    setDNS(server, getServerIp(server), "A");
    
    //set MX records to point to mail server
    setDNS(domain, server + ".", "MX", 0);
    
    //create domain file and upload to server
    var domain_file = createMailDomainFile(domain);
    log("created domain file: " + domain_file);
    uploadFile(domain_file, server, "/etc/mail/domains/");

    //create passwd file and upload to server
    var passwd_file = createMailPasswdFile(domain);
    log("created passwd file: " + passwd_file);
    uploadFile(passwd_file, server, "/etc/mail/auth/" + domain );
    
} else {
    log("Command '" + cmd + "' not recognized. Bailing.");
}

removeLock();
